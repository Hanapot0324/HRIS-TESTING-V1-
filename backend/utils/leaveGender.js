/**
 * leave_table.gender_restriction rule, shared by the leave routes and the staff
 * self-service (/api/me) routes. Mirrors isLeaveAllowedForGender in
 * frontend/src/components/LEAVE/leaveGenderUtils.js so both sides agree.
 */
const isLeaveAllowedForGender = (genderRestriction, employeeGender) => {
  const restriction = String(genderRestriction || "").trim().toLowerCase();
  if (!restriction) return true;
  const g = String(employeeGender || "").trim().toLowerCase();
  if (!g) return false;
  if (restriction === "male") return g === "male" || g === "m";
  if (restriction === "female") return g === "female" || g === "f";
  return true;
};

module.exports = { isLeaveAllowedForGender };
