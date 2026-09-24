const db = require('../db');

/** Rows per multi-row INSERT — keeps each statement well under max_allowed_packet. */
const CHUNK_SIZE = 500;

/**
 * Insert the same notification for many employees using chunked multi-row
 * INSERTs, run one chunk at a time.
 *
 * Announcements / holidays / suspensions used to fire one INSERT per employee
 * all at once (thousands of parallel queries). That overflowed the pool queue
 * ("Queue limit reached"): most notifications were silently lost and every
 * other user's requests stalled or failed with 500 while it drained.
 *
 * Keeps the old column fallbacks for installs whose notifications table lacks
 * the newer columns: the first column set that works is reused for later chunks.
 *
 * @returns {Promise<number>} number of rows inserted
 */
async function insertNotificationsBulk(
  employeeNumbers,
  { description, type = null, actionLink = null, announcementId = null },
) {
  const recipients = [
    ...new Set(
      (employeeNumbers || []).map((e) => String(e ?? '').trim()).filter(Boolean),
    ),
  ];
  if (recipients.length === 0) return 0;

  const variants = [];
  if (announcementId != null) {
    variants.push({
      columns: 'employeeNumber, description, read_status, notification_type, action_link, announcement_id',
      row: (emp) => [emp, description, 0, type, actionLink, announcementId],
    });
  }
  variants.push({
    columns: 'employeeNumber, description, read_status, notification_type, action_link',
    row: (emp) => [emp, description, 0, type, actionLink],
  });
  variants.push({
    columns: 'employeeNumber, description, read_status',
    row: (emp) => [emp, description, 0],
  });

  let variantIndex = 0;
  let inserted = 0;

  for (let i = 0; i < recipients.length; i += CHUNK_SIZE) {
    const chunk = recipients.slice(i, i + CHUNK_SIZE);
    let lastErr = null;

    while (variantIndex < variants.length) {
      const v = variants[variantIndex];
      try {
        const [result] = await db
          .promise()
          .query(`INSERT INTO notifications (${v.columns}) VALUES ?`, [chunk.map(v.row)]);
        inserted += result.affectedRows || 0;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        variantIndex++;
      }
    }

    if (lastErr) {
      console.error('Bulk notification insert failed:', lastErr.message);
      break;
    }
  }

  return inserted;
}

module.exports = { insertNotificationsBulk };
