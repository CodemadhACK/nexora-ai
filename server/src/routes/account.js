'use strict';

/** Profile, résumé, job description, preferences, privacy (§54–§59, §66, §67). */

const express = require('express');
const { get, all, run, transaction } = require('../db');
const { requireAuth, requireReauth } = require('../middleware/auth');
const { newId } = require('../lib/crypto');
const audit = require('../lib/audit');
const v = require('../lib/validate');
const documents = require('../lib/documents');
const aiRouter = require('../services/aiRouter');
const credits = require('../services/credits');
const entitlements = require('../services/entitlements');
const { rateLimit } = require('../middleware/rateLimit');
const { notFound, badRequest } = require('../lib/errors');

const router = express.Router();
router.use(requireAuth);

// Uploads and AI extraction are both expensive; a tighter ceiling than the
// general account routes get.
const uploadLimit = rateLimit({
  windowMs: 60_000,
  max: 8,
  key: (req) => `upload:${req.user?.id || req.clientIp}`,
  message: 'Give the last upload a moment to finish.',
});

// ───────────────────────── profile (§55, §59) ─────────────────────────

router.get('/profile', (req, res) => {
  const profile = get('SELECT * FROM user_profiles WHERE user_id = ?', req.user.id);
  const resume = get(
    `SELECT id, filename, extraction_status, extracted, size_bytes, created_at
       FROM resumes WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1`,
    req.user.id,
  );
  const jd = get(
    `SELECT id, title, company, url, body FROM job_descriptions
      WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1`,
    req.user.id,
  );

  res.json({
    profile: profile && {
      targetRole: profile.target_role,
      experienceYears: profile.experience_years,
      seniority: profile.seniority,
      skills: JSON.parse(profile.skills || '[]'),
      industries: JSON.parse(profile.industries || '[]'),
      targetCompanies: JSON.parse(profile.target_companies || '[]'),
      preferredLanguage: profile.preferred_language,
      preferredCodeLanguage: profile.preferred_code_language,
      answerLength: profile.answer_length,
      answerTone: profile.answer_tone,
      technicalDepth: profile.technical_depth,
      onboardedAt: profile.onboarded_at,
    },
    resume: resume && {
      id: resume.id,
      filename: resume.filename,
      status: resume.extraction_status,
      extracted: JSON.parse(resume.extracted || '{}'),
      sizeBytes: resume.size_bytes,
      createdAt: resume.created_at,
    },
    jobDescription: jd,
  });
});

router.put('/profile', (req, res, next) => {
  try {
    const b = req.body;
    run(
      `UPDATE user_profiles
          SET target_role=?, experience_years=?, seniority=?, skills=?, industries=?,
              target_companies=?, preferred_language=?, preferred_code_language=?,
              answer_length=?, answer_tone=?, technical_depth=?, updated_at=datetime('now')
        WHERE user_id=?`,
      v.str(b.targetRole ?? '', 'Target role', { min: 0, max: 120 }),
      v.int(b.experienceYears ?? 0, 'Experience', { min: 0, max: 60 }),
      v.str(b.seniority ?? '', 'Seniority', { min: 0, max: 40 }),
      JSON.stringify(v.jsonArray(b.skills ?? [], 'Skills').slice(0, 50)),
      JSON.stringify(v.jsonArray(b.industries ?? [], 'Industries').slice(0, 20)),
      JSON.stringify(v.jsonArray(b.targetCompanies ?? [], 'Companies').slice(0, 20)),
      v.str(b.preferredLanguage ?? 'English', 'Language', { min: 0, max: 40 }),
      v.str(b.preferredCodeLanguage ?? 'Python', 'Code language', { min: 0, max: 40 }),
      v.oneOf(b.answerLength ?? 'BALANCED', ['CONCISE', 'BALANCED', 'DETAILED'], 'Answer length'),
      v.oneOf(b.answerTone ?? 'NATURAL', ['NATURAL', 'PROFESSIONAL', 'CONVERSATIONAL'], 'Tone'),
      v.int(b.technicalDepth ?? 3, 'Technical depth', { min: 1, max: 5 }),
      req.user.id,
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** §58: marks onboarding complete. Skipping steps is allowed by design. */
router.post('/onboarding/complete', (req, res) => {
  run(`UPDATE user_profiles SET onboarded_at=datetime('now') WHERE user_id=?`, req.user.id);
  res.json({ ok: true });
});

// ───────────────────────── résumé (§56) ─────────────────────────

/**
 * Saves a resume the user pasted in. `/resume/upload` handles PDF and DOCX
 * files; this paste path stays because it is the only one that works for a
 * scanned CV with no text layer.
 */
router.post('/resume', (req, res, next) => {
  try {
    const filename = v.str(req.body.filename ?? 'resume.txt', 'Filename', { max: 200 });
    const text = v.str(req.body.text, 'Résumé text', { min: 40, max: 100_000 });

    const id = newId('res');
    transaction(() => {
      // One active résumé at a time; older ones are kept but deactivated.
      run('UPDATE resumes SET is_active = 0 WHERE user_id = ?', req.user.id);
      run(
        `INSERT INTO resumes (id, user_id, filename, mime_type, size_bytes, raw_text, extraction_status)
         VALUES (?, ?, ?, 'text/plain', ?, ?, 'PENDING')`,
        id,
        req.user.id,
        filename,
        Buffer.byteLength(text, 'utf8'),
        text,
      );
    });
    res.status(201).json({ ok: true, resumeId: id });
  } catch (err) {
    next(err);
  }
});

/**
 * Uploads a résumé file (§56). PDF, DOCX or plain text.
 *
 * The bytes are kept alongside the extracted text so the original can be
 * previewed and re-parsed later; `resumes` itself holds only text, so listing
 * résumés never drags a blob through SQLite.
 */
router.post('/resume/upload', uploadLimit, async (req, res, next) => {
  try {
    const filename = v.str(req.body.filename ?? 'resume', 'Filename', { max: 200 });
    const mimeType = v.str(req.body.mimeType ?? '', 'Type', { min: 0, max: 120 });
    if (typeof req.body.dataBase64 !== 'string' || !req.body.dataBase64) {
      throw badRequest('No file was received.');
    }

    const extracted = await documents.extractText({
      filename,
      mimeType,
      dataBase64: req.body.dataBase64,
    });

    const resumeId = newId('res');
    const blobId = newId('blb');
    transaction(() => {
      run('UPDATE resumes SET is_active = 0 WHERE user_id = ?', req.user.id);
      run(
        `INSERT INTO file_blobs (id, user_id, filename, mime_type, size_bytes, content)
         VALUES (?, ?, ?, ?, ?, ?)`,
        blobId,
        req.user.id,
        filename,
        mimeType,
        extracted.sizeBytes,
        extracted.buffer,
      );
      run(
        `INSERT INTO resumes (id, user_id, filename, mime_type, size_bytes, raw_text, extraction_status)
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
        resumeId,
        req.user.id,
        filename,
        mimeType,
        extracted.sizeBytes,
        extracted.text,
      );
    });

    res.status(201).json({
      ok: true,
      resumeId,
      kind: extracted.kind,
      pages: extracted.pages,
      characters: extracted.text.length,
      preview: extracted.text.slice(0, 600),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Runs AI extraction over a stored résumé (§56).
 *
 * Nothing here is trusted blindly: the result is stored as `DONE`, surfaced for
 * the user to correct, and marked `EDITED` once they do. The prompt is told to
 * flag uncertainty rather than guess.
 */
router.post('/resume/:id/analyse', uploadLimit, async (req, res, next) => {
  try {
    const resume = get('SELECT * FROM resumes WHERE id=? AND user_id=?', req.params.id, req.user.id);
    if (!resume) throw notFound('No such résumé.');

    entitlements.assertFeature(req.user.id, 'resume_analysis');

    const active = get(
      `SELECT pv.body FROM prompts p JOIN prompt_versions pv ON pv.id = p.active_version_id
        WHERE p.key = 'resume_analysis'`,
    );

    const result = await aiRouter.complete({
      userId: req.user.id,
      feature: 'resume_analysis',
      intent: 'resume_analysis',
      actionKey: 'ai.resume_analysis',
      system:
        `${active?.body || 'Extract structured information from the résumé provided.'}\n\n` +
        'Reply with JSON only, no prose and no code fence, in exactly this shape:\n' +
        '{"skills":["..."],"experience":[{"title":"","company":"","period":"","highlights":["..."]}],' +
        '"education":[{"qualification":"","institution":"","year":""}],' +
        '"projects":[{"name":"","summary":""}],"certifications":["..."],' +
        '"likely_questions":["..."],"uncertain":["..."]}\n' +
        'Put anything you had to infer into "uncertain" rather than stating it as fact.',
      messages: [
        {
          role: 'user',
          parts: [
            {
              type: 'text',
              // Fenced and labelled: a résumé is untrusted text and must not be
              // able to redirect the model.
              text: `<<<RESUME\n${resume.raw_text.slice(0, 20_000)}\nRESUME>>>`,
            },
          ],
        },
      ],
    });

    const start = result.text.indexOf('{');
    const end = result.text.lastIndexOf('}');
    let parsed = null;
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(result.text.slice(start, end + 1));
      } catch {
        parsed = null;
      }
    }
    if (!parsed) {
      run(`UPDATE resumes SET extraction_status='FAILED' WHERE id=?`, resume.id);
      throw badRequest('The analysis came back unreadable. Please try again.');
    }

    run(
      `UPDATE resumes SET extracted=?, extraction_status='DONE', updated_at=datetime('now') WHERE id=?`,
      JSON.stringify(parsed).slice(0, 50_000),
      resume.id,
    );

    res.json({
      extracted: parsed,
      creditsCharged: result.creditsCharged,
      creditBalance: credits.balance(req.user.id),
      note: 'Review these details — the extraction is a starting point, not a fact.',
    });
  } catch (err) {
    next(err);
  }
});

/** §56: the user reviews and corrects what the AI extracted — never blind trust. */
router.put('/resume/:id/extracted', (req, res, next) => {
  try {
    const resume = get('SELECT * FROM resumes WHERE id=? AND user_id=?', req.params.id, req.user.id);
    if (!resume) throw notFound('No such résumé.');
    if (typeof req.body.extracted !== 'object' || req.body.extracted === null) {
      throw badRequest('Expected an object of extracted fields.');
    }
    run(
      `UPDATE resumes SET extracted=?, extraction_status='EDITED', updated_at=datetime('now') WHERE id=?`,
      JSON.stringify(req.body.extracted).slice(0, 50_000),
      resume.id,
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/resume/:id', (req, res, next) => {
  try {
    const resume = get('SELECT * FROM resumes WHERE id=? AND user_id=?', req.params.id, req.user.id);
    if (!resume) throw notFound('No such résumé.');
    run('DELETE FROM resumes WHERE id = ?', resume.id);
    audit.fromRequest(req, { action: 'resume.deleted', targetType: 'resume', targetId: resume.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────── job description (§57) ─────────────────────────

router.post('/job-description', (req, res, next) => {
  try {
    const id = newId('jd');
    transaction(() => {
      run('UPDATE job_descriptions SET is_active = 0 WHERE user_id = ?', req.user.id);
      run(
        `INSERT INTO job_descriptions (id, user_id, title, company, url, body)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        req.user.id,
        v.str(req.body.title ?? '', 'Title', { min: 0, max: 160 }),
        v.str(req.body.company ?? '', 'Company', { min: 0, max: 160 }),
        v.str(req.body.url ?? '', 'URL', { min: 0, max: 500 }),
        v.str(req.body.body ?? '', 'Job description', { min: 0, max: 40_000 }),
      );
    });
    res.status(201).json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────── notifications (§67) ─────────────────────────

router.get('/notifications/preferences', (req, res) => {
  const prefs = get('SELECT * FROM notification_preferences WHERE user_id = ?', req.user.id);
  res.json({
    preferences: {
      productUpdates: !!prefs?.product_updates,
      interviewReminders: !!prefs?.interview_reminders,
    },
    note: 'Payment and security emails are transactional and cannot be switched off.',
  });
});

router.put('/notifications/preferences', (req, res) => {
  run(
    `UPDATE notification_preferences SET product_updates=?, interview_reminders=?,
            updated_at=datetime('now') WHERE user_id=?`,
    v.bool(req.body.productUpdates) ? 1 : 0,
    v.bool(req.body.interviewReminders) ? 1 : 0,
    req.user.id,
  );
  res.json({ ok: true });
});

// ───────────────────────── privacy (§66) ─────────────────────────

/** Everything the platform holds on this user, in one JSON document. */
router.get('/export', (req, res) => {
  res.json({
    exportedAt: new Date().toISOString(),
    account: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      createdAt: req.user.created_at,
    },
    profile: get('SELECT * FROM user_profiles WHERE user_id = ?', req.user.id),
    resumes: all('SELECT id, filename, raw_text, extracted, created_at FROM resumes WHERE user_id = ?', req.user.id),
    jobDescriptions: all('SELECT * FROM job_descriptions WHERE user_id = ?', req.user.id),
    interviews: all('SELECT * FROM interview_sessions WHERE user_id = ?', req.user.id),
    messages: all(
      `SELECT m.* FROM interview_messages m
         JOIN interview_sessions s ON s.id = m.session_id WHERE s.user_id = ?`,
      req.user.id,
    ),
    credits: all('SELECT * FROM credit_transactions WHERE user_id = ?', req.user.id),
    payments: all('SELECT * FROM payment_orders WHERE user_id = ?', req.user.id),
    invoices: all('SELECT * FROM invoices WHERE user_id = ?', req.user.id),
  });
});

router.delete('/interview-history', (req, res) => {
  run('DELETE FROM interview_sessions WHERE user_id = ?', req.user.id); // messages cascade
  audit.fromRequest(req, { action: 'privacy.interview_history_deleted', targetType: 'user', targetId: req.user.id });
  res.json({ ok: true });
});

/**
 * Account deletion. Personal content goes; the financial record does not —
 * invoices and payment orders must survive for tax and dispute purposes, so the
 * account is anonymised rather than hard-deleted.
 */
router.post('/delete', requireReauth, (req, res, next) => {
  try {
    const id = req.user.id;
    transaction(() => {
      run('DELETE FROM resumes WHERE user_id = ?', id);
      run('DELETE FROM job_descriptions WHERE user_id = ?', id);
      run('DELETE FROM interview_sessions WHERE user_id = ?', id);
      run('DELETE FROM auth_identities WHERE user_id = ?', id);
      run(`UPDATE sessions SET revoked_at=datetime('now') WHERE user_id=? AND revoked_at IS NULL`, id);
      run(
        `UPDATE users
            SET email = 'deleted+' || id || '@invalid', name = 'Deleted account',
                password_hash = '', phone = '', status = 'DELETED', updated_at = datetime('now')
          WHERE id = ?`,
        id,
      );
    });
    audit.log({ actorId: null, action: 'account.deleted', targetType: 'user', targetId: id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
