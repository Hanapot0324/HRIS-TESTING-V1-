-- Indexes for queries every logged-in user triggers (run once).
-- index.js also creates these at startup when no index on the
-- column exists. Skip any statement whose index already exists.

-- Home / HomeAdmin notification list + unread count, realtime refreshes
CREATE INDEX idx_notifications_emp_id ON notifications (employeeNumber, id);

-- Device punch poller (every 10s) and admin dashboard attendance charts
CREATE INDEX idx_ari_attendance_datetime ON AttendanceRecordInfo (AttendanceDateTime);


-- Per-employee lookups behind screens every staff member opens
-- (Home, DTR, Payslip, Leave). index.js creates these at startup too.
CREATE INDEX idx_users_employee_number ON users (employeeNumber);
CREATE INDEX idx_person_table_agency_employee_num ON person_table (agencyEmployeeNum);
CREATE INDEX idx_attendancerecord_person_date ON attendancerecord (personID, date);
CREATE INDEX idx_officialtime_employee_dates ON officialtime (employeeID, startDate, endDate);
CREATE INDEX idx_leave_request_employee_created ON leave_request (employeeNumber, created_at);
CREATE INDEX idx_leave_assignment_employee_code ON leave_assignment (employeeNumber, leave_code);
CREATE INDEX idx_payroll_released_employee ON payroll_released (employeeNumber, dateReleased);
CREATE INDEX idx_employment_category_employee ON employment_category (employeeNumber);
CREATE INDEX idx_transaction_table_employee ON transaction_table (employee_id);
CREATE INDEX idx_notes_employee ON notes (employee_number, created_at);
CREATE INDEX idx_events_employee ON events (employee_number, created_at);
CREATE INDEX idx_service_credit_employee ON service_credit (employeeNumber);
CREATE INDEX idx_cto_credit_employee ON cto_credit (employeeNumber);
