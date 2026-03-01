'use strict';

const router   = require('express').Router();
const dbModule = require('../db');
const { optionalAuth, requireAuth, requireAdmin } = require('../auth');
const { addPoints, buildBranchTree } = require('../db');

function db() { return dbModule.db; }

function formatDiscussion(row, userEmail) {
  userEmail = (userEmail || '').toLowerCase();
  const likes = db().prepare(`SELECT user_email FROM discussion_likes WHERE discussion_id=?`).all(row.id).map(r => r.user_email);
  return {
    id:           row.id,
    title:        row.title,
    body:         row.body,
    author:       row.author,
    author_email: row.author_email,
    authorEmail:  row.author_email,
    tags:         JSON.parse(row.tags || '[]'),
    is_open:      row.is_open,
    isOpen:       !!row.is_open,
    created_at:   row.created_at,
    createdAt:    row.created_at * 1000,
    liked:        userEmail ? likes.includes(userEmail) : false,
    likeCount:    likes.length,
    branch_count: db().prepare(`SELECT COUNT(*) AS n FROM branches WHERE discussion_id=?`).get(row.id).n,
    branches:     buildBranchTree(row.id, null)
  };
}

router.get('/', optionalAuth, (req, res) => {
  try {
    const { q, tag } = req.query;
    let rows;
    if (q && q.trim().length >= 2) {
      const like = `%${q.trim().toLowerCase()}%`;
      rows = db().prepare(`SELECT * FROM discussions WHERE lower(title) LIKE ? OR lower(body) LIKE ? ORDER BY created_at DESC`).all(like, like);
    } else if (tag) {
      rows = db().prepare(`SELECT * FROM discussions WHERE lower(tags) LIKE ? ORDER BY created_at DESC`).all(`%"${tag.toLowerCase()}"%`);
    } else {
      rows = db().prepare(`SELECT * FROM discussions ORDER BY created_at DESC`).all();
    }
    res.json(rows.map(r => formatDiscussion(r, req.user?.email)));
  } catch (err) { console.error('[GET /discussions]', err); res.status(500).json({ error: 'Could not load discussions.' }); }
});

router.get('/:id', optionalAuth, (req, res) => {
  try {
    const row = db().prepare(`SELECT * FROM discussions WHERE id=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Discussion not found.' });
    res.json(formatDiscussion(row, req.user?.email));
  } catch (err) { console.error('[GET /discussions/:id]', err); res.status(500).json({ error: 'Could not load discussion.' }); }
});

router.post('/', requireAuth, (req, res) => {
  try {
    const { title, body, tags } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required.' });
    const tagsArr = Array.isArray(tags) ? tags : (tags||'').split(',').map(t=>t.trim().toLowerCase()).filter(Boolean);
    const info = db().prepare(`INSERT INTO discussions (title,body,author,author_email,tags) VALUES (?,?,?,?,?)`).run(
      title.trim(), (body||'').trim(), req.user.name, req.user.email.toLowerCase(), JSON.stringify(tagsArr));
    addPoints(req.user.name, 5, 'Started a discussion');
    const created = db().prepare(`SELECT * FROM discussions WHERE id=?`).get(info.lastInsertRowid);
    if (!created) return res.status(500).json({ error: 'Discussion saved but could not be retrieved. Please refresh.' });
    res.status(201).json(formatDiscussion(created, req.user.email));
  } catch (err) { console.error('[POST /discussions]', err); res.status(500).json({ error: 'Could not create discussion.' }); }
});

// Admin OR discussion author can delete
router.delete('/:id', requireAuth, (req, res) => {
  try {
    const disc = db().prepare(`SELECT * FROM discussions WHERE id=?`).get(req.params.id);
    if (!disc) return res.status(404).json({ error: 'Discussion not found.' });
    const isOwner = disc.author_email === req.user.email.toLowerCase();
    if (!req.user.isAdmin && !isOwner) return res.status(403).json({ error: 'Not allowed.' });
    db().prepare(`DELETE FROM discussions WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) { console.error('[DELETE /discussions/:id]', err); res.status(500).json({ error: 'Could not delete discussion.' }); }
});

router.post('/:id/close', requireAdmin, (req, res) => {
  try {
    const row = db().prepare(`SELECT * FROM discussions WHERE id=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Discussion not found.' });
    db().prepare(`UPDATE discussions SET is_open=? WHERE id=?`).run(row.is_open ? 0 : 1, req.params.id);
    res.json({ ok: true, isOpen: !row.is_open });
  } catch (err) { console.error('[POST /discussions/:id/close]', err); res.status(500).json({ error: 'Could not update.' }); }
});

router.post('/:id/like', requireAuth, (req, res) => {
  try {
    const discId    = req.params.id;
    const userEmail = req.user.email.toLowerCase();
    const disc      = db().prepare(`SELECT * FROM discussions WHERE id=?`).get(discId);
    if (!disc) return res.status(404).json({ error: 'Discussion not found.' });
    const existing  = db().prepare(`SELECT 1 FROM discussion_likes WHERE discussion_id=? AND user_email=?`).get(discId, userEmail);
    if (existing) {
      db().prepare(`DELETE FROM discussion_likes WHERE discussion_id=? AND user_email=?`).run(discId, userEmail);
    } else {
      db().prepare(`INSERT INTO discussion_likes (discussion_id,user_email) VALUES (?,?)`).run(discId, userEmail);
      if (disc.author !== req.user.name) addPoints(disc.author, 1, 'Received a discussion like');
    }
    const likes = db().prepare(`SELECT user_email FROM discussion_likes WHERE discussion_id=?`).all(discId).map(r => r.user_email);
    res.json({ ok: true, liked: !existing, likeCount: likes.length });
  } catch (err) { console.error('[POST /discussions/:id/like]', err); res.status(500).json({ error: 'Could not toggle like.' }); }
});

router.post('/:id/branches', requireAuth, (req, res) => {
  try {
    const { text, parentBranchId, type } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'Text is required.' });
    const disc = db().prepare(`SELECT * FROM discussions WHERE id=?`).get(req.params.id);
    if (!disc) return res.status(404).json({ error: 'Discussion not found.' });
    if (!disc.is_open) return res.status(400).json({ error: 'Discussion is closed.' });

    let depth = 0;
    const parentId = parentBranchId || null;
    if (parentId) {
      const parent = db().prepare(`SELECT * FROM branches WHERE id=?`).get(parentId);
      if (!parent) return res.status(404).json({ error: 'Parent branch not found.' });
      depth = parent.depth + 1;
    }

    const info = db().prepare(`INSERT INTO branches (discussion_id,parent_id,author,author_email,text,type,depth) VALUES (?,?,?,?,?,?,?)`).run(
      req.params.id, parentId, req.user.name, req.user.email.toLowerCase(),
      text.trim(), type || (parentId ? 'branch' : 'root'), depth);
    addPoints(req.user.name, 3, 'Added a branch');
    const branch = db().prepare(`SELECT * FROM branches WHERE id=?`).get(info.lastInsertRowid);
    if (!branch) return res.status(500).json({ error: 'Branch saved but could not be retrieved. Please refresh.' });
    res.status(201).json({ ...branch, leaves: [], mergeVotes: [], children: [] });
  } catch (err) { console.error('[POST /discussions/:id/branches]', err); res.status(500).json({ error: 'Could not add branch.' }); }
});

router.post('/:id/branches/:bid/leaf', requireAuth, (req, res) => {
  try {
    const branchId  = req.params.bid;
    const userEmail = req.user.email.toLowerCase();
    const branch    = db().prepare(`SELECT * FROM branches WHERE id=? AND discussion_id=?`).get(branchId, req.params.id);
    if (!branch) return res.status(404).json({ error: 'Branch not found.' });
    const existing  = db().prepare(`SELECT 1 FROM leaves WHERE branch_id=? AND user_email=?`).get(branchId, userEmail);
    if (existing) {
      db().prepare(`DELETE FROM leaves WHERE branch_id=? AND user_email=?`).run(branchId, userEmail);
    } else {
      db().prepare(`INSERT INTO leaves (branch_id,user_name,user_email) VALUES (?,?,?)`).run(branchId, req.user.name, userEmail);
      if (branch.author !== req.user.name) addPoints(branch.author, 1, 'Received a leaf');
    }
    const leaves = db().prepare(`SELECT user_email FROM leaves WHERE branch_id=?`).all(branchId).map(r => r.user_email);
    res.json({ ok: true, liked: !existing, leaves });
  } catch (err) { console.error('[POST /branches/:bid/leaf]', err); res.status(500).json({ error: 'Could not toggle leaf.' }); }
});

router.post('/:id/branches/:bid/merge', requireAuth, (req, res) => {
  try {
    const branchId  = req.params.bid;
    const userEmail = req.user.email.toLowerCase();
    const branch    = db().prepare(`SELECT * FROM branches WHERE id=? AND discussion_id=?`).get(branchId, req.params.id);
    if (!branch) return res.status(404).json({ error: 'Branch not found.' });
    const existing  = db().prepare(`SELECT 1 FROM merge_votes WHERE branch_id=? AND user_email=?`).get(branchId, userEmail);
    if (existing) {
      db().prepare(`DELETE FROM merge_votes WHERE branch_id=? AND user_email=?`).run(branchId, userEmail);
    } else {
      db().prepare(`INSERT INTO merge_votes (branch_id,user_email) VALUES (?,?)`).run(branchId, userEmail);
      if (branch.author !== req.user.name) addPoints(branch.author, 2, 'Received a merge vote');
    }
    const mergeVotes = db().prepare(`SELECT user_email FROM merge_votes WHERE branch_id=?`).all(branchId).map(r => r.user_email);
    res.json({ ok: true, voted: !existing, mergeVotes });
  } catch (err) { console.error('[POST /branches/:bid/merge]', err); res.status(500).json({ error: 'Could not toggle merge vote.' }); }
});

// Admin OR branch author can delete
router.delete('/:id/branches/:bid', requireAuth, (req, res) => {
  try {
    const branch = db().prepare(`SELECT * FROM branches WHERE id=? AND discussion_id=?`).get(req.params.bid, req.params.id);
    if (!branch) return res.status(404).json({ error: 'Branch not found.' });
    const isOwner = branch.author_email === req.user.email.toLowerCase();
    if (!req.user.isAdmin && !isOwner) return res.status(403).json({ error: 'Not allowed.' });
    db().prepare(`DELETE FROM branches WHERE id=?`).run(req.params.bid);
    res.json({ ok: true });
  } catch (err) { console.error('[DELETE /branches/:bid]', err); res.status(500).json({ error: 'Could not delete branch.' }); }
});

module.exports = router;
