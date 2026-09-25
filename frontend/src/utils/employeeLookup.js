import axios from "axios";
import API_BASE_URL from "../apiConfig";
import { getAuthHeaders } from "./auth";

const CHUNK = 1000;

/**
 * Look up many employees in a few requests instead of one request per row.
 * Resolves to a Map of employeeNumber (string) -> row shaped like
 * GET /Remittance/employees/:employeeNumber ({ employeeNumber, name,
 * firstName, middleName, lastName, nameExtension }). Missing employees are
 * simply absent. A failed chunk leaves its employees absent, like the old
 * per-row lookups that fell back to "Unknown".
 */
export async function fetchEmployeesByNumber(employeeNumbers) {
  const ids = [
    ...new Set(
      (employeeNumbers || [])
        .map((e) => String(e ?? "").trim())
        .filter(Boolean),
    ),
  ];
  const found = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    try {
      const res = await axios.post(
        `${API_BASE_URL}/Remittance/employees/lookup`,
        { employeeNumbers: ids.slice(i, i + CHUNK) },
        getAuthHeaders(),
      );
      for (const row of Array.isArray(res.data) ? res.data : []) {
        const key = String(row.employeeNumber ?? "").trim();
        if (key && !found.has(key)) found.set(key, row);
      }
    } catch (err) {
      console.error("Employee lookup failed:", err);
    }
  }
  return found;
}
