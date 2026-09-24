-- Indexes for queries every logged-in user triggers (run once).
-- index.js also creates both at startup when no index on the
-- column exists. Skip any statement whose index already exists.

-- Home / HomeAdmin notification list + unread count, realtime refreshes
CREATE INDEX idx_notifications_emp_id ON notifications (employeeNumber, id);

-- Device punch poller (every 10s) and admin dashboard attendance charts
CREATE INDEX idx_ari_attendance_datetime ON AttendanceRecordInfo (AttendanceDateTime);

