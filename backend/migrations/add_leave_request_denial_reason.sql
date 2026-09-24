-- Reason text captured from HR when a leave request is denied.
ALTER TABLE leave_request
  ADD COLUMN denial_reason TEXT NULL DEFAULT NULL
    COMMENT 'Reason provided by HR when status is set to Denied (3)';
