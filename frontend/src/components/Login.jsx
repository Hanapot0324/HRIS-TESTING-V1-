import API_BASE_URL from "../apiConfig";
import React, { useState, useEffect, useMemo, useRef } from "react";
import ReCAPTCHA from "react-google-recaptcha";
import {
  Alert,
  TextField,
  Button,
  Container,
  Link,
  Box,
  Paper,
  Typography,
  Modal,
  InputAdornment,
  IconButton,
  Chip,
  Dialog,
  Checkbox,
  FormControlLabel,
  Stepper,
  Step,
  StepLabel,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import {
  BadgeOutlined,
  LockOutlined,
  LoginOutlined,
  CheckCircleOutline,
  ErrorOutline,
  VerifiedUserOutlined,
  KeyboardArrowDown,
  Announcement as AnnouncementIcon,
  AccessTime as AccessTimeIcon,
  Close as CloseIcon,
  Event as EventIcon,
  Block as BlockIcon,
  ArrowBack,
  MarkEmailReadOutlined,
  EmailOutlined,
  LockResetOutlined,
} from "@mui/icons-material";
import LoadingOverlay from "../components/LoadingOverlay";
import bg from "../assets/EaristBG.PNG";
import logo from "../assets/logo.PNG";

// ─── Expiry helpers ───────────────────────────────────────────────────────────
const isNotExpired = (date_end) => {
  if (!date_end) return true;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const e = new Date(date_end);
  e.setHours(0, 0, 0, 0);
  return today <= e;
};

// ─── Build combined carousel items ───────────────────────────────────────────
const buildCarouselItems = (announcements = [], suspensions = [], rawHolidays = []) => {
  const holidayItems = rawHolidays
    .filter((h) => (h.status || "").toLowerCase() === "active")
    .filter((h) => isNotExpired(h.date_end || h.date))
    .map((h) => ({
      id: `holiday-${h.id}`,
      type: "HOLIDAY",
      title: h.title || h.description || "",
      about: h.about || "Official holiday.",
      date: h.date_start || h.date_end || h.date,
      date_start: h.date_start || h.date,
      date_end: h.date_end || h.date,
      image: h.image || null,
    }));

  const suspensionItems = suspensions
    .filter((s) => isNotExpired(s.date_end))
    .map((s) => ({
      id: `suspension-${s.id}`,
      type: "SUSPENSION",
      title: s.title || "",
      about: s.about || "",
      date: s.date_start || s.date_end || s.date,
      date_start: s.date_start || s.date,
      date_end: s.date_end || s.date,
      image: s.image || null,
    }));

  const announcementItems = announcements
    .filter((a) => isNotExpired(a.date_end))
    .map((a) => ({
      ...a,
      type: "ANNOUNCEMENT",
      date: a.date_start || a.date_end || a.date,
      date_start: a.date_start || a.date,
      date_end: a.date_end || a.date,
    }));

  return [...holidayItems, ...suspensionItems, ...announcementItems].sort(
    (a, b) => new Date(b.date_start || b.date) - new Date(a.date_start || a.date)
  );
};

const getTypeLabel = (type) => {
  if (type === "HOLIDAY") return "Holiday";
  if (type === "SUSPENSION") return "Suspension";
  return "Announcement";
};

// ─── Forgot Password Sub-Component (inline) ──────────────────────────────────
const ForgotPasswordInline = ({ onBack, crimson, crimsonDark }) => {
  const [fpStep, setFpStep] = useState(0);
  const [fpData, setFpData] = useState({ email: "", verificationCode: "", newPassword: "", confirmPassword: "" });
  const [fpError, setFpError] = useState("");
  const [fpLoading, setFpLoading] = useState(false);
  const [showPasswords, setShowPasswords] = useState({ new: false, confirm: false });
  const [passwordConfirmed, setPasswordConfirmed] = useState(false);
  const [showVerificationModal, setShowVerificationModal] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const recaptchaRef = useRef(null);
  const [recaptchaToken, setRecaptchaToken] = useState("");

  const steps = ["Enter Email", "Verify Code", "New Password"];

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFpData((prev) => ({ ...prev, [name]: value }));
    if (fpError) setFpError("");
  };

  const handleSubmitEmail = async (e) => {
    e.preventDefault();
    if (!fpData.email) { setFpError("Please enter your email address."); return; }
    if (!recaptchaToken) { setFpError("Please verify that you are not a robot."); return; }
    setFpLoading(true); setFpError("");
    try {
      const res = await fetch(`${API_BASE_URL}/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: fpData.email, recaptchaToken }),
      });
      const data = await res.json();
      if (res.ok) {
        setFpStep(1);
        setShowVerificationModal(true);
        recaptchaRef.current?.reset();
        setRecaptchaToken("");
      } else {
        setFpError(data.error || "Failed to send verification code.");
      }
    } catch { setFpError("Something went wrong. Please try again."); }
    finally { setFpLoading(false); }
  };

  const handleVerifyCode = async (e) => {
    e.preventDefault();
    if (!fpData.verificationCode) { setFpError("Please enter the verification code."); return; }
    setFpLoading(true); setFpError("");
    try {
      const res = await fetch(`${API_BASE_URL}/verify-reset-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: fpData.email, code: fpData.verificationCode }),
      });
      const data = await res.json();
      if (res.ok) setFpStep(2);
      else setFpError(data.error || "Invalid verification code.");
    } catch { setFpError("Something went wrong. Please try again."); }
    finally { setFpLoading(false); }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    if (!fpData.newPassword || !fpData.confirmPassword) { setFpError("Please fill in both password fields."); return; }
    if (fpData.newPassword !== fpData.confirmPassword) { setFpError("Passwords do not match."); return; }
    if (fpData.newPassword.length < 6) { setFpError("Password must be at least 6 characters long."); return; }
    if (!passwordConfirmed) { setFpError("Please confirm that you want to change your password."); return; }
    setFpLoading(true); setFpError("");
    try {
      const res = await fetch(`${API_BASE_URL}/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: fpData.email, newPassword: fpData.newPassword, confirmPassword: fpData.confirmPassword }),
      });
      const data = await res.json();
      if (res.ok) setShowSuccessModal(true);
      else setFpError(data.error || "Failed to reset password.");
    } catch { setFpError("Something went wrong. Please try again."); }
    finally { setFpLoading(false); }
  };

  const inputSx = {
    mb: 2,
    "& .MuiOutlinedInput-root": {
      borderRadius: 2,
      background: "rgba(255,255,255,0.8)",
      "& fieldset": { borderColor: "rgba(128,0,32,0.25)" },
      "&:hover fieldset": { borderColor: "rgba(128,0,32,0.45)" },
      "&.Mui-focused fieldset": { borderColor: crimson },
      "& input": { color: crimsonDark, fontSize: "0.9rem" },
    },
    "& .MuiInputLabel-root": { color: "rgba(128,0,32,0.55)" },
    "& .MuiInputLabel-root.Mui-focused": { color: crimson },
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <Box sx={{ mb: { xs: 2, sm: 3 }, textAlign: "center" }}>
        <Typography sx={{ fontSize: "0.68rem", fontWeight: 700, letterSpacing: "0.22em", color: "rgba(128,0,32,0.55)", textTransform: "uppercase", mb: 0.75 }}>
          Account Recovery
        </Typography>
        <Typography sx={{ fontSize: { xs: "1.2rem", sm: "1.45rem" }, fontWeight: 800, color: crimsonDark, lineHeight: 1.2, letterSpacing: "-0.01em" }}>
          Reset Password
        </Typography>
        <Box sx={{ width: 44, height: 3, background: "linear-gradient(90deg, #800020, #e84a4a)", borderRadius: "2px", mx: "auto", mt: 1.5 }} />
      </Box>

      {/* Stepper */}
      <Stepper activeStep={fpStep} sx={{ mb: { xs: 2, sm: 3 } }} alternativeLabel>
        {steps.map((label) => (
          <Step key={label}>
            <StepLabel
              StepIconProps={{
                sx: {
                  "&.Mui-active": { color: crimson },
                  "&.Mui-completed": { color: crimson },
                  color: "rgba(128,0,32,0.25)",
                },
              }}
              sx={{ "& .MuiStepLabel-label": { fontSize: { xs: "0.62rem", sm: "0.7rem" }, color: "rgba(75,0,0,0.55)", fontWeight: 600 } }}
            >
              {label}
            </StepLabel>
          </Step>
        ))}
      </Stepper>

      {/* Error */}
      {fpError && (
        <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, p: "10px 14px", borderRadius: "10px", bgcolor: "rgba(200,30,30,0.04)", border: "1px solid rgba(200,30,30,0.12)", color: "#8a2020", fontSize: "0.8rem", mb: 2 }}>
          <ErrorOutline sx={{ fontSize: 16, flexShrink: 0, mt: "1px" }} />
          <Box>{fpError}</Box>
        </Box>
      )}

      {/* Step 0: Email */}
      {fpStep === 0 && (
        <Box component="form" onSubmit={handleSubmitEmail} sx={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <Typography sx={{ mb: 2.5, color: "rgba(128,0,32,0.6)", fontSize: "0.82rem", textAlign: "center", lineHeight: 1.5 }}>
            Enter your email address and we'll send you a verification code.
          </Typography>
          <TextField
            type="email"
            name="email"
            label="Email Address"
            fullWidth
            value={fpData.email}
            onChange={handleChange}
            sx={inputSx}
            InputProps={{
              startAdornment: <InputAdornment position="start"><EmailOutlined sx={{ color: "rgba(128,0,32,0.45)", fontSize: 18 }} /></InputAdornment>,
            }}
            required
          />
          <Box sx={{ display: "flex", justifyContent: "center", mb: 2.5, transform: { xs: "scale(0.78)", sm: "scale(0.88)" }, transformOrigin: "center" }}>
            <ReCAPTCHA
              sitekey="6LczLdwrAAAAADm2hy8vJDkvKc05KJNDY8TQgagG"
              onChange={(token) => setRecaptchaToken(token)}
              ref={recaptchaRef}
              theme="light"
              size="normal"
            />
          </Box>
          <Box sx={{ mt: "auto" }}>
            <Box
              component="button"
              type="submit"
              disabled={fpLoading || !recaptchaToken}
              sx={{
                width: "100%", height: 50, background: !recaptchaToken ? "rgba(128,0,32,0.15)" : "#800020",
                border: "none", borderRadius: "12px", color: "#fff", fontSize: "0.9rem", fontWeight: 600,
                cursor: !recaptchaToken ? "not-allowed" : "pointer", opacity: !recaptchaToken ? 0.55 : 1,
                display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
                transition: "background 0.2s", fontFamily: "inherit",
                "&:hover:not(:disabled)": { background: "#6a001a" },
              }}
            >
              <MarkEmailReadOutlined sx={{ fontSize: 18 }} />
              {fpLoading ? "Sending..." : "Send Verification Code"}
            </Box>
            <Box sx={{ mt: 2.5, textAlign: "center" }}>
              <Link component="button" type="button" onClick={onBack} underline="hover" sx={{ fontSize: "0.8rem", color: crimson, display: "inline-flex", alignItems: "center", gap: 0.5 }}>
                <ArrowBack sx={{ fontSize: 14 }} /> Back to Sign In
              </Link>
            </Box>
          </Box>
        </Box>
      )}

      {/* Step 1: Verify Code */}
      {fpStep === 1 && (
        <Box component="form" onSubmit={handleVerifyCode} sx={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <Typography sx={{ mb: 2.5, color: "rgba(128,0,32,0.6)", fontSize: "0.82rem", textAlign: "center", lineHeight: 1.5 }}>
            Enter the 6-digit code sent to <Box component="span" sx={{ fontWeight: 600, color: crimsonDark }}>{fpData.email}</Box>
          </Typography>
          <TextField
            type="text"
            name="verificationCode"
            placeholder="• • • • • •"
            fullWidth
            value={fpData.verificationCode}
            onChange={handleChange}
            inputProps={{ maxLength: 6, style: { textAlign: "center", fontSize: "1.8rem", letterSpacing: "0.8rem", color: crimsonDark } }}
            sx={{ ...inputSx, mb: 3 }}
            required
          />
          <Box sx={{ flex: 1 }} />
          <Box sx={{ display: "flex", gap: 1.5 }}>
            <Box
              component="button"
              type="button"
              onClick={() => setFpStep(0)}
              sx={{
                flex: 1, height: 50, background: "transparent", border: "1px solid rgba(128,0,32,0.3)",
                borderRadius: "12px", color: crimson, fontSize: "0.88rem", fontWeight: 600,
                cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px",
                transition: "background 0.2s", fontFamily: "inherit",
                "&:hover": { background: "rgba(128,0,32,0.05)" },
              }}
            >
              <ArrowBack sx={{ fontSize: 16 }} /> Back
            </Box>
            <Box
              component="button"
              type="submit"
              disabled={fpLoading}
              sx={{
                flex: 1, height: 50, background: "#800020", border: "none", borderRadius: "12px",
                color: "#fff", fontSize: "0.88rem", fontWeight: 600, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", gap: "6px",
                transition: "background 0.2s", fontFamily: "inherit",
                "&:hover": { background: "#6a001a" },
                "&:disabled": { opacity: 0.55, cursor: "not-allowed" },
              }}
            >
              <VerifiedUserOutlined sx={{ fontSize: 16 }} />
              {fpLoading ? "Verifying..." : "Verify Code"}
            </Box>
          </Box>
        </Box>
      )}

      {/* Step 2: New Password */}
      {fpStep === 2 && (
        <Box component="form" onSubmit={handleResetPassword} sx={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <Typography sx={{ mb: 2.5, color: "rgba(128,0,32,0.6)", fontSize: "0.82rem", textAlign: "center", lineHeight: 1.5 }}>
            Create a new password for your account.
          </Typography>
          <TextField
            type={showPasswords.new ? "text" : "password"}
            name="newPassword"
            label="New Password"
            fullWidth
            value={fpData.newPassword}
            onChange={handleChange}
            sx={inputSx}
            InputProps={{
              startAdornment: <InputAdornment position="start"><LockOutlined sx={{ color: "rgba(128,0,32,0.45)", fontSize: 18 }} /></InputAdornment>,
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton onClick={() => setShowPasswords((p) => ({ ...p, new: !p.new }))} size="small" sx={{ color: "rgba(128,0,32,0.4)" }}>
                    {showPasswords.new ? <VerifiedUserOutlined sx={{ fontSize: 17 }} /> : <LockOutlined sx={{ fontSize: 17 }} />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
            required
          />
          <TextField
            type={showPasswords.confirm ? "text" : "password"}
            name="confirmPassword"
            label="Confirm New Password"
            fullWidth
            value={fpData.confirmPassword}
            onChange={handleChange}
            sx={{ ...inputSx, mb: 1.5 }}
            InputProps={{
              startAdornment: <InputAdornment position="start"><LockOutlined sx={{ color: "rgba(128,0,32,0.45)", fontSize: 18 }} /></InputAdornment>,
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton onClick={() => setShowPasswords((p) => ({ ...p, confirm: !p.confirm }))} size="small" sx={{ color: "rgba(128,0,32,0.4)" }}>
                    {showPasswords.confirm ? <VerifiedUserOutlined sx={{ fontSize: 17 }} /> : <LockOutlined sx={{ fontSize: 17 }} />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
            required
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={passwordConfirmed}
                onChange={(e) => setPasswordConfirmed(e.target.checked)}
                sx={{ color: crimson, "&.Mui-checked": { color: crimson }, transform: "scale(0.85)" }}
              />
            }
            label={<Typography sx={{ fontSize: "0.78rem", color: crimsonDark }}>I confirm that I want to change my password</Typography>}
            sx={{ mb: 2.5, ml: 0 }}
          />
          <Box sx={{ flex: 1 }} />
          <Box sx={{ display: "flex", gap: 1.5 }}>
            <Box
              component="button"
              type="button"
              onClick={() => setFpStep(1)}
              sx={{
                flex: 1, height: 50, background: "transparent", border: "1px solid rgba(128,0,32,0.3)",
                borderRadius: "12px", color: crimson, fontSize: "0.88rem", fontWeight: 600,
                cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px",
                transition: "background 0.2s", fontFamily: "inherit",
                "&:hover": { background: "rgba(128,0,32,0.05)" },
              }}
            >
              <ArrowBack sx={{ fontSize: 16 }} /> Back
            </Box>
            <Box
              component="button"
              type="submit"
              disabled={fpLoading || !passwordConfirmed}
              sx={{
                flex: 1, height: 50, background: "#800020", border: "none", borderRadius: "12px",
                color: "#fff", fontSize: "0.88rem", fontWeight: 600, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", gap: "6px",
                transition: "background 0.2s", fontFamily: "inherit",
                "&:hover:not(:disabled)": { background: "#6a001a" },
                "&:disabled": { opacity: 0.55, cursor: "not-allowed" },
              }}
            >
              <LockResetOutlined sx={{ fontSize: 16 }} />
              {fpLoading ? "Updating..." : "Update Password"}
            </Box>
          </Box>
        </Box>
      )}

      {/* Verification sent overlay */}
      {showVerificationModal && (
        <Box sx={{ position: "absolute", inset: 0, bgcolor: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "24px", zIndex: 20 }}>
          <Box sx={{ width: "85%", bgcolor: "rgba(255,248,231,0.98)", borderRadius: 3, p: { xs: 2.5, sm: 3.5 }, textAlign: "center", border: "1px solid rgba(128,0,32,0.15)" }}>
            <MarkEmailReadOutlined sx={{ fontSize: 56, color: crimson, mb: 1.5 }} />
            <Typography sx={{ fontWeight: 700, mb: 1, color: crimsonDark, fontSize: "1.1rem" }}>Verification Code Sent</Typography>
            <Typography sx={{ color: crimson, mb: 2.5, fontSize: "0.83rem", lineHeight: 1.6 }}>
              A code was sent to <Box component="span" sx={{ fontWeight: 600 }}>{fpData.email}</Box>. Check your inbox and enter it below.
            </Typography>
            <Box
              component="button"
              onClick={() => setShowVerificationModal(false)}
              sx={{ width: "100%", height: 46, background: "#800020", border: "none", borderRadius: "10px", color: "#fff", fontSize: "0.9rem", fontWeight: 600, cursor: "pointer", fontFamily: "inherit", "&:hover": { background: "#6a001a" } }}
            >
              Okay
            </Box>
          </Box>
        </Box>
      )}

      {/* Success overlay */}
      {showSuccessModal && (
        <Box sx={{ position: "absolute", inset: 0, bgcolor: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "24px", zIndex: 20 }}>
          <Box sx={{ width: "85%", bgcolor: "rgba(255,248,231,0.98)", borderRadius: 3, p: { xs: 2.5, sm: 3.5 }, textAlign: "center", border: "1px solid rgba(128,0,32,0.15)" }}>
            <CheckCircleOutline sx={{ fontSize: 56, color: "#4caf50", mb: 1.5 }} />
            <Typography sx={{ fontWeight: 700, mb: 1, color: crimsonDark, fontSize: "1.1rem" }}>Password Updated!</Typography>
            <Typography sx={{ color: crimson, mb: 2.5, fontSize: "0.83rem", lineHeight: 1.6 }}>
              Your password has been updated successfully. You can now sign in with your new password.
            </Typography>
            <Box
              component="button"
              onClick={onBack}
              sx={{ width: "100%", height: 46, background: "#800020", border: "none", borderRadius: "10px", color: "#fff", fontSize: "0.9rem", fontWeight: 600, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", mx: "auto", "&:hover": { background: "#6a001a" } }}
            >
              <LockOutlined sx={{ fontSize: 16 }} /> Back to Sign In
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  );
};

// ─── Main Login Component ─────────────────────────────────────────────────────
const Login = () => {
  const OTP_LENGTH = 6;
  const OTP_RESEND_SECONDS = 3 * 60;

  const theme = useTheme();
  const isXs = useMediaQuery(theme.breakpoints.down("sm"));      // phones
  const isSm = useMediaQuery(theme.breakpoints.down("md"));      // phones + small tablets
  const isMd = useMediaQuery(theme.breakpoints.down("lg"));      // tablets
  const showCarousel = useMediaQuery(theme.breakpoints.up("md")); // hide carousel below md
  // Below md the layout stacks and grows naturally (auto height) so nothing
  // ever gets clipped — the fixed-height cross-fade card only applies once
  // the carousel appears alongside it (md and up).
  const isCompact = !showCarousel;

  // Fixed card height — only used at md+ where there's room for the two-column
  // layout. Below that, the card is auto-height (see CARD_HEIGHT usage below).
  const CARD_HEIGHT = isMd ? 480 : 560;

  // ── Carousel card width (px) — must match the card width in the JSX below
  const CARD_W = isMd ? 420 : 720;

  const [showIntro, setShowIntro] = useState(true);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [employeeNumber, setEmployeeNumber] = useState("");
  const [formData, setFormData] = useState({ password: "" });
  const [errMessage, setErrorMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [show2FA, setShow2FA] = useState(false);
  const [pinDigits, setPinDigits] = useState(Array(OTP_LENGTH).fill(""));
  const [twoFactorError, setTwoFactorError] = useState("");
  const [success, setSuccess] = useState("");
  const [userEmail, setUserEmail] = useState("");
  // Server-issued ticket chaining password -> 2FA -> session token.
  const [loginTicket, setLoginTicket] = useState("");
  const [attempts, setAttempts] = useState(0);
  const [isLocked, setIsLocked] = useState(false);
  const [lockTimer, setLockTimer] = useState(0);
  const [codeExpireTimer, setCodeExpireTimer] = useState(0);
  const [resendTimer, setResendTimer] = useState(0);
  const [resendLoading, setResendLoading] = useState(false);
  const [twoFactorLoading, setTwoFactorLoading] = useState(false);
  const pinInputRefs = useRef([]);

  const [announcements, setAnnouncements] = useState([]);
  const [rawHolidays, setRawHolidays] = useState([]);
  const [suspensions, setSuspensions] = useState([]);

  const [currentSlide, setCurrentSlide] = useState(0);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [openPolicy, setOpenPolicy] = useState(false);
  const [openFAQ, setOpenFAQ] = useState(false);
  const [showPasswordPrompt, setShowPasswordPrompt] = useState(false);
  const [isDefaultPassword, setIsDefaultPassword] = useState(false);
  const [showLaterModal, setShowLaterModal] = useState(false);
  const [dashWarning, setDashWarning] = useState("");
  const [dontRemindToday, setDontRemindToday] = useState(false);

  const [loginAttempts, setLoginAttempts] = useState(0);
  const [isLoginLocked, setIsLoginLocked] = useState(false);
  const [loginLockTimer, setLoginLockTimer] = useState(0);

  const crimson = "#800020";
  const crimsonDark = "#4B0000";
  const crimsonDeep = "#A52A2A";
  const cream = "#FFF8E7";

  // ── Build carousel items (deduplicated by id) ──────────────────────────────
  const carouselItems = useMemo(
    () => buildCarouselItems(announcements, suspensions, rawHolidays),
    [announcements, suspensions, rawHolidays]
  );

  // ── FIX: Only duplicate when there are 2+ items so a single item never
  //         appears twice side-by-side. The seamless CSS marquee only needs
  //         the duplication when the strip is long enough to loop.
  const carouselDuped = useMemo(() => {
    if (carouselItems.length <= 1) {
      // Single (or zero) items — no clone, no looping needed
      return carouselItems.map((item) => ({ ...item, _key: `orig-${item.id}` }));
    }
    return [
      ...carouselItems.map((item) => ({ ...item, _key: `orig-${item.id}` })),
      ...carouselItems.map((item) => ({ ...item, _key: `clone-${item.id}` })),
    ];
  }, [carouselItems]);

  // Total scroll distance = one full set of original items (half the duplicated strip)
  const scrollPx = carouselItems.length * (CARD_W + 16); // 16px = MUI gap:2
  const animDuration = Math.max(carouselItems.length * 5, 15);

  // Whether to animate at all (only when 2+ items)
  const shouldAnimate = carouselItems.length > 1;

  useEffect(() => {
    // Horizontal overflow should never be allowed to produce a scrollbar,
    // regardless of viewport width/zoom or what other components on the
    // page render. Only vertical scrolling toggles with the layout mode.
    document.documentElement.style.overflowX = "hidden";
    document.body.style.overflowX = "hidden";

    if (isCompact) {
      // Below md the card stacks and auto-sizes to its content, which can
      // exceed 100vh, so allow natural vertical scrolling there instead of
      // clipping anything.
      document.body.style.overflowY = "";
      document.documentElement.style.overflowY = "";
      return () => {
        document.body.style.overflow = "";
        document.documentElement.style.overflow = "";
      };
    }

    document.body.style.overflowY = "hidden";
    document.documentElement.style.overflowY = "hidden";
    return () => {
      document.body.style.overflow = "";
      document.documentElement.style.overflow = "";
    };
  }, [isCompact]);

  useEffect(() => {
    if (!showIntro) return;
    const handleKeyDown = (e) => {
      if (e.code === "Space" || e.code === "Enter") {
        e.preventDefault();
        const introEl = document.getElementById("introSlide");
        if (introEl) introEl.style.transform = "translateY(-100%)";
        setTimeout(() => setShowIntro(false), 800);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showIntro]);

  const pin = useMemo(() => pinDigits.join(""), [pinDigits]);

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const lockData = localStorage.getItem("loginLockData");
    if (lockData) {
      const { lockUntil } = JSON.parse(lockData);
      const now = Date.now();
      if (lockUntil > now) {
        setIsLoginLocked(true);
        setLoginLockTimer(Math.ceil((lockUntil - now) / 1000));
      } else {
        localStorage.removeItem("loginLockData");
      }
    }
    const reminderData = localStorage.getItem("passwordReminderSkipped");
    if (reminderData) {
      try {
        const { date } = JSON.parse(reminderData);
        const today = new Date().toDateString();
        if (date !== today) {
          localStorage.removeItem("passwordReminderSkipped");
          sessionStorage.removeItem("passwordReminderSkipped");
        }
      } catch {
        localStorage.removeItem("passwordReminderSkipped");
        sessionStorage.removeItem("passwordReminderSkipped");
      }
    }
  }, []);

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const [annRes, holidayRes, suspRes] = await Promise.allSettled([
          fetch(`${API_BASE_URL}/api/announcements`).then((r) => r.json()),
          fetch(`${API_BASE_URL}/holiday`).then((r) => r.json()),
          fetch(`${API_BASE_URL}/api/suspensions`).then((r) => r.json()),
        ]);
        if (annRes.status === "fulfilled" && Array.isArray(annRes.value)) setAnnouncements(annRes.value);
        if (holidayRes.status === "fulfilled" && Array.isArray(holidayRes.value)) setRawHolidays(holidayRes.value);
        if (suspRes.status === "fulfilled" && Array.isArray(suspRes.value)) setSuspensions(suspRes.value);
      } catch (error) {
        console.error("Error fetching carousel data:", error);
      }
    };
    fetchAll();
    const interval = setInterval(fetchAll, 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let interval;
    if (isLocked && lockTimer > 0) {
      interval = setInterval(() => {
        setLockTimer((prev) => {
          if (prev <= 1) { setIsLocked(false); setAttempts(0); setTwoFactorError(""); return 0; }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isLocked, lockTimer]);

  useEffect(() => {
    let interval;
    if (isLoginLocked && loginLockTimer > 0) {
      interval = setInterval(() => {
        setLoginLockTimer((prev) => {
          if (prev <= 1) {
            setIsLoginLocked(false); setLoginAttempts(0);
            localStorage.removeItem("loginLockData"); setErrorMessage("");
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isLoginLocked, loginLockTimer]);

  useEffect(() => {
    let interval;
    if (codeExpireTimer > 0) {
      interval = setInterval(() => setCodeExpireTimer((prev) => (prev <= 1 ? 0 : prev - 1)), 1000);
    }
    return () => clearInterval(interval);
  }, [codeExpireTimer]);

  useEffect(() => {
    let interval;
    if (resendTimer > 0) {
      interval = setInterval(() => setResendTimer((prev) => (prev <= 1 ? 0 : prev - 1)), 1000);
    }
    return () => clearInterval(interval);
  }, [resendTimer]);

  useEffect(() => {
    if (!show2FA) return;
    setPinDigits(Array(OTP_LENGTH).fill(""));
    setTimeout(() => pinInputRefs.current[0]?.focus(), 120);
  }, [show2FA]);

  useEffect(() => {
    if (errMessage && !isLoginLocked) {
      const t = setTimeout(() => setErrorMessage(""), 3000);
      return () => clearTimeout(t);
    }
  }, [errMessage, isLoginLocked]);

  useEffect(() => {
    if (twoFactorError) { const t = setTimeout(() => setTwoFactorError(""), 3000); return () => clearTimeout(t); }
  }, [twoFactorError]);

  useEffect(() => {
    if (success) { const t = setTimeout(() => setSuccess(""), 3000); return () => clearTimeout(t); }
  }, [success]);

  useEffect(() => {
    if (dashWarning) { const t = setTimeout(() => setDashWarning(""), 3000); return () => clearTimeout(t); }
  }, [dashWarning]);

  const handleChanges = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleEmployeeNumberChange = (e) => {
    const raw = e.target.value ?? "";
    if (raw.includes("-")) {
      setDashWarning("Hyphens (dashes) are not allowed in the employee number.");
    } else {
      setDashWarning("");
    }
    const allowed = String(raw).replace(/[^0-9A-Za-z]/g, "").toUpperCase();
    setEmployeeNumber(allowed);
  };

  const send2FACode = async (ticket, options = {}) => {
    const { isResend = false } = options;
    setResendLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/send-2fa-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginTicket: ticket }),
      });
      const data = await res.json();
      if (res.ok) {
        setSuccess("Verification code sent to your email.");
        setCodeExpireTimer(OTP_RESEND_SECONDS);
        if (isResend) setResendTimer(OTP_RESEND_SECONDS);
        setAttempts(0); setIsLocked(false); setTwoFactorError("");
        setPinDigits(Array(OTP_LENGTH).fill(""));
      } else {
        setTwoFactorError(data.error || "Failed to send code.");
      }
    } catch {
      setTwoFactorError("Failed to send verification code.");
    } finally {
      setResendLoading(false);
    }
  };

  const shouldSkipPasswordReminder = (employeeNumber) => {
    let reminderData = localStorage.getItem("passwordReminderSkipped");
    if (!reminderData) {
      reminderData = sessionStorage.getItem("passwordReminderSkipped");
      if (reminderData) localStorage.setItem("passwordReminderSkipped", reminderData);
    }
    if (!reminderData) return false;
    try {
      const { date, employeeNumber: skippedEmpNum } = JSON.parse(reminderData);
      const today = new Date().toDateString();
      const normalizedCurrent = String(employeeNumber).trim().toUpperCase();
      const normalizedSkipped = String(skippedEmpNum).trim().toUpperCase();
      const shouldSkip = date === today && normalizedSkipped === normalizedCurrent;
      if (date !== today) {
        localStorage.removeItem("passwordReminderSkipped");
        sessionStorage.removeItem("passwordReminderSkipped");
      }
      return shouldSkip;
    } catch {
      localStorage.removeItem("passwordReminderSkipped");
      sessionStorage.removeItem("passwordReminderSkipped");
      return false;
    }
  };

  const navigateToDashboard = (role) => {
    if (role === "superadmin" || role === "administrator" || role === "technical") {
      window.location.href = "/admin-home";
    } else {
      window.location.href = "/home";
    }
  };

  const handlePostLoginFlow = (loginData) => {
    localStorage.setItem("token", loginData.token);
    const decoded = JSON.parse(atob(loginData.token.split(".")[1]));
    localStorage.setItem("employeeNumber", decoded.employeeNumber || "");
    localStorage.setItem("role", decoded.role || "");
    if (loginData.isDefaultPassword) {
      if (shouldSkipPasswordReminder(decoded.employeeNumber)) {
        navigateToDashboard(decoded.role);
      } else {
        setIsDefaultPassword(true);
        setShowPasswordPrompt(true);
        setShow2FA(false);
      }
    } else {
      navigateToDashboard(decoded.role);
    }
  };

  const verify2FACode = async () => {
    if (!pin.trim()) { setTwoFactorError("Please enter all 6 digits."); return; }
    if (codeExpireTimer <= 0) { setTwoFactorError("Code expired. Please resend a new code."); return; }
    if (isLocked) { setTwoFactorError(`Too many failed attempts. Wait ${formatTime(lockTimer)}.`); return; }
    setTwoFactorLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/verify-2fa-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginTicket, code: pin }),
      });
      const data = await res.json();
      if (res.ok && data.verified) {
        const loginRes = await fetch(`${API_BASE_URL}/complete-2fa-login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ loginTicket: data.loginTicket }),
        });
        const loginData = await loginRes.json();
        if (loginRes.ok) handlePostLoginFlow(loginData);
        else setTwoFactorError(loginData.error || "Login completion failed.");
      } else {
        const newAttempts = attempts + 1;
        setAttempts(newAttempts);
        if (newAttempts >= 3) {
          setIsLocked(true); setLockTimer(60);
          setTwoFactorError("Too many failed attempts. Locked for 1 min.");
          setPinDigits(Array(OTP_LENGTH).fill(""));
        } else {
          setTwoFactorError(data.error || "Invalid verification code. Try again.");
          setPinDigits(Array(OTP_LENGTH).fill(""));
          setTimeout(() => pinInputRefs.current[0]?.focus(), 80);
        }
      }
    } catch {
      setTwoFactorError("Verification failed. Please try again.");
    } finally {
      setTwoFactorLoading(false);
    }
  };

  const formatTime = (seconds) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const maskEmail = (email) => {
    const val = String(email || "").trim();
    if (!val.includes("@")) return val;
    const [local, domain] = val.split("@");
    if (!local) return val;
    return `${local.slice(0, 1)}${"*".repeat(Math.max(local.length - 1, 4))}@${domain}`;
  };

  const handlePinChange = (index, rawValue) => {
    if (isLocked) return;
    const numeric = String(rawValue || "").replace(/\D/g, "");
    const next = [...pinDigits];
    if (!numeric) { next[index] = ""; setPinDigits(next); return; }
    if (numeric.length > 1) {
      numeric.slice(0, OTP_LENGTH - index).split("").forEach((char, offset) => { next[index + offset] = char; });
      setPinDigits(next);
      pinInputRefs.current[Math.min(index + numeric.length, OTP_LENGTH - 1)]?.focus();
      return;
    }
    next[index] = numeric;
    setPinDigits(next);
    if (index < OTP_LENGTH - 1) pinInputRefs.current[index + 1]?.focus();
  };

  const handlePinKeyDown = (index, e) => {
    if (e.key === "Backspace") {
      if (pinDigits[index]) {
        const next = [...pinDigits]; next[index] = ""; setPinDigits(next);
      } else if (index > 0) {
        const next = [...pinDigits]; next[index - 1] = ""; setPinDigits(next);
        pinInputRefs.current[index - 1]?.focus();
      }
      e.preventDefault();
    }
  };

  const handlePinPaste = (e) => {
    e.preventDefault();
    if (isLocked) return;
    const pasted = (e.clipboardData || window.clipboardData).getData("text").replace(/\D/g, "").slice(0, OTP_LENGTH);
    if (!pasted) return;
    const next = Array(OTP_LENGTH).fill("");
    pasted.split("").forEach((char, index) => { next[index] = char; });
    setPinDigits(next);
    pinInputRefs.current[Math.min(pasted.length, OTP_LENGTH) - 1]?.focus();
  };

  const attemptMessage = useMemo(() => {
    if (isLocked) return "Account locked";
    if (attempts > 0 && attempts < 3) {
      const remaining = 3 - attempts;
      return `${remaining} attempt${remaining !== 1 ? "s" : ""} left`;
    }
    return "";
  }, [attempts, isLocked]);

  const handleLogin = async (e) => {
    e.preventDefault();
    if (isLoginLocked) {
      setErrorMessage(`Too many failed login attempts. Please wait ${formatTime(loginLockTimer)} before trying again.`);
      return;
    }
    if (!employeeNumber.trim() || !formData.password) { setErrorMessage("Please fill all credentials"); return; }
    setLoading(true); setErrorMessage("");
    try {
      const response = await fetch(`${API_BASE_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeNumber, password: formData.password }),
      });
      const data = await response.json();
      if (response.ok) {
        setLoginAttempts(0); localStorage.removeItem("loginLockData");
        const canonicalEmp = data.employeeNumber || employeeNumber;
        setUserEmail(data.email); setLoginTicket(data.loginTicket);
        try {
          let globalMfaEnabled = true;
          try {
            const globalMfaResponse = await fetch(`${API_BASE_URL}/api/system-settings/global_mfa_enabled`);
            if (globalMfaResponse.ok) {
              const globalMfaData = await globalMfaResponse.json();
              const globalRaw = globalMfaData.setting_value;
              globalMfaEnabled = globalRaw === "true" || globalRaw === true || globalRaw === "1" || globalRaw === 1;
            }
          } catch {}
          if (!globalMfaEnabled) {
            const loginRes = await fetch(`${API_BASE_URL}/complete-2fa-login`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ loginTicket: data.loginTicket }),
            });
            const loginData = await loginRes.json();
            if (loginRes.ok) handlePostLoginFlow(loginData);
            else setErrorMessage(loginData.error || "Login completion failed.");
          } else {
            const prefResponse = await fetch(`${API_BASE_URL}/api/user-preferences/${canonicalEmp}`);
            let mfaEnabled = true;
            if (prefResponse.ok) {
              const prefData = await prefResponse.json();
              mfaEnabled = !(prefData.enable_mfa === 0 || prefData.enable_mfa === false);
            }
            if (mfaEnabled) {
              await send2FACode(data.loginTicket); setShow2FA(true);
            } else {
              const loginRes = await fetch(`${API_BASE_URL}/complete-2fa-login`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ loginTicket: data.loginTicket }),
              });
              const loginData = await loginRes.json();
              if (loginRes.ok) handlePostLoginFlow(loginData);
              else setErrorMessage(loginData.error || "Login completion failed.");
            }
          }
        } catch {
          await send2FACode(data.loginTicket); setShow2FA(true);
        }
      } else {
        const newLoginAttempts = loginAttempts + 1;
        setLoginAttempts(newLoginAttempts);
        if (newLoginAttempts >= 3) {
          setIsLoginLocked(true); setLoginLockTimer(2 * 60);
          localStorage.setItem("loginLockData", JSON.stringify({ lockUntil: Date.now() + 2 * 60 * 1000 }));
          setErrorMessage("Too many failed login attempts. Your account is locked for 2 minutes.");
        } else {
          const remaining = 3 - newLoginAttempts;
          setErrorMessage(`${data.error || data.message || "Invalid credentials"}. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.`);
        }
      }
    } catch {
      setErrorMessage("Connection error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const blobPositions = React.useMemo(
    () => Array.from({ length: 6 }).map((_, i) => ({
      size: 60 + i * 20, top: Math.random() * 70, left: Math.random() * 70,
      delay: i * 0.3, duration: 1 + i * 2,
    })),
    []
  );

  const blobs = blobPositions.map((blob, i) => (
    <Box
      key={i}
      sx={{
        position: "absolute", width: blob.size, height: blob.size,
        borderRadius: "50%", background: "linear-gradient(135deg, #800020, #A52A2A)",
        opacity: 0.15 + i * 0.1, top: `${blob.top}%`, left: `${blob.left}%`,
        animation: `float${i} ${blob.duration}s ease-in-out ${blob.delay}s infinite`,
        [`@keyframes float${i}`]: {
          "0%,100%": { transform: "translate(0,0)" },
          "50%": { transform: "translate(15px, -10px) rotate(20deg)" },
        },
      }}
    />
  ));

  return (
    <>
      <Box sx={{ position: "fixed", inset: 0, backgroundImage: `url(${bg})`, backgroundSize: "cover", backgroundPosition: "center", animation: "zoomPulse 20s ease-in-out infinite", "@keyframes zoomPulse": { "0%,100%": { transform: "scale(1)" }, "50%": { transform: "scale(1.05)" } } }} />
      <Box sx={{ position: "fixed", inset: 0, background: "linear-gradient(135deg, rgba(75,0,0,0.84) 0%, rgba(0,0,0,0.90) 100%)" }} />

      <Box sx={{ position: "fixed", inset: 0, zIndex: 10, overflowX: "hidden", overflowY: isCompact ? "auto" : "hidden" }}>
        <LoadingOverlay open={loading} message="Please wait..." />

        <Box
          sx={{
            minHeight: "100vh",
            width: "100%",
            display: "flex",
            flexDirection: { xs: "column", md: "row" },
            alignItems: "center",
            justifyContent: "center",
            overflow: "visible",
            gap: { xs: 1, sm: 2, md: 5, lg: 8, xl: "100px" },
            px: { xs: 1.5, sm: 4, md: 4, lg: 8, xl: "160px" },
            py: { xs: 1, sm: 2, md: 0 },
            boxSizing: "border-box",
          }}
        >

          {/* ── Compact announcements banner (phones/tablets, below md) ──────── */}
          {isCompact && carouselItems.length > 0 && (
            <Box sx={{ width: "100%", maxWidth: 420, mx: "auto", order: -1 }}>
              <Box
                sx={{
                  display: "flex",
                  gap: 1.5,
                  overflowX: carouselItems.length > 1 ? "auto" : "visible",
                  overflowY: "hidden",
                  scrollSnapType: carouselItems.length > 1 ? "x mandatory" : "none",
                  WebkitOverflowScrolling: "touch",
                  justifyContent: carouselItems.length > 1 ? "flex-start" : "center",
                  "&::-webkit-scrollbar": { display: "none" },
                  scrollbarWidth: "none",
                }}
              >
                {carouselItems.map((item) => (
                  <Box
                    key={item.id}
                    sx={{
                      flex: carouselItems.length > 1 ? "0 0 88%" : "0 0 100%",
                      scrollSnapAlign: "center",
                      borderRadius: { xs: "16px", sm: "18px" },
                      overflow: "hidden",
                      position: "relative",
                      boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
                      border: "1px solid rgba(255,255,255,0.14)",
                    }}
                  >
                    <Box
                      component="img"
                      src={item.image ? `${API_BASE_URL}${item.image}` : "/api/placeholder/620/540"}
                      alt={item.title || item.type}
                      sx={{
                        width: "100%",
                        height: { xs: 100, sm: 160 },
                        objectFit: "cover",
                        display: "block",
                        filter: "brightness(0.62)",
                      }}
                    />
                    <Box sx={{ position: "absolute", bottom: 0, width: "100%", background: "linear-gradient(0deg, rgba(0,0,0,0.82) 0%, transparent 100%)", p: { xs: "14px 12px 8px", sm: "22px 16px 14px" } }}>
                      <Chip
                        size="small"
                        label={getTypeLabel(item.type)}
                        icon={
                          item.type === "HOLIDAY"
                            ? <EventIcon sx={{ fontSize: "12px !important", color: "#fff !important" }} />
                            : item.type === "SUSPENSION"
                            ? <BlockIcon sx={{ fontSize: "12px !important", color: "#fff !important" }} />
                            : <AnnouncementIcon sx={{ fontSize: "12px !important", color: "#fff !important" }} />
                        }
                        sx={{
                          mb: { xs: 0.4, sm: 0.75 },
                          bgcolor:
                            item.type === "HOLIDAY"
                              ? "rgba(237,108,2,0.85)"
                              : item.type === "SUSPENSION"
                              ? "rgba(211,47,47,0.85)"
                              : "rgba(128,0,32,0.85)",
                          color: "#fff",
                          fontWeight: 700,
                          fontSize: { xs: "0.52rem", sm: "0.6rem" },
                          height: { xs: 16, sm: 19 },
                          "& .MuiChip-icon": { color: "#fff" },
                        }}
                      />
                      <Typography sx={{ color: "#fff", fontWeight: 700, fontSize: { xs: "0.72rem", sm: "0.85rem" }, lineHeight: 1.25, mb: 0.25 }}>
                        {item.title}
                      </Typography>
                      <Typography sx={{ color: "rgba(255,255,255,0.7)", fontSize: { xs: "0.6rem", sm: "0.7rem" } }}>
                        {item.date ? new Date(item.date).toDateString() : ""}
                      </Typography>
                    </Box>
                  </Box>
                ))}
              </Box>
              {carouselItems.length > 1 && (
                <Box sx={{ display: "flex", justifyContent: "center", gap: 0.75, mt: { xs: 0.75, sm: 1.25 } }}>
                  {carouselItems.map((item) => (
                    <Box key={`dot-${item.id}`} sx={{ width: 6, height: 6, borderRadius: "50%", bgcolor: "rgba(255,255,255,0.35)" }} />
                  ))}
                </Box>
              )}
            </Box>
          )}

          {/* ── LEFT — Carousel (hidden on phones/small tablets) ─────────────── */}
          {showCarousel && (
            <Box
              sx={{
                flex: { md: "0 0 50%", lg: "0 0 55%" },
                maxWidth: { md: "50%", lg: "55%" },
                overflow: "hidden",
                position: "relative",
                py: 0,
                minWidth: 0,
                alignSelf: "center",
                // Center content when there's only one item (no marquee)
                display: "flex",
                justifyContent: shouldAnimate ? "flex-start" : "center",
                // Mask fade edges so the seamless loop looks polished
                maskImage: shouldAnimate
                  ? "linear-gradient(to right, transparent 0%, black 6%, black 94%, transparent 100%)"
                  : "none",
                WebkitMaskImage: shouldAnimate
                  ? "linear-gradient(to right, transparent 0%, black 6%, black 94%, transparent 100%)"
                  : "none",
              }}
            >
              {carouselItems.length > 0 ? (
                <>
                  {/* Inject animation keyframes — only when 2+ items */}
                  <style>{`
                    @keyframes marqueeScroll {
                      0%   { transform: translateX(0); }
                      100% { transform: translateX(-${scrollPx}px); }
                    }
                    .carousel-track {
                      display: flex;
                      gap: 16px;
                      width: max-content;
                      ${shouldAnimate
                        ? `animation: marqueeScroll ${animDuration}s linear infinite;`
                        : ""}
                    }
                    .carousel-track:hover {
                      animation-play-state: paused;
                    }
                  `}</style>
                  <Box className="carousel-track">
                    {carouselDuped.map((item) => (
                      <Box
                        key={item._key}
                        sx={{
                          flex: `0 0 ${CARD_W}px`,
                          borderRadius: "16px",
                          overflow: "hidden",
                          position: "relative",
                          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
                          transition: "transform 0.3s",
                          "&:hover": { transform: "scale(1.03)" },
                        }}
                      >
                        <Box
                          component="img"
                          src={item.image ? `${API_BASE_URL}${item.image}` : "/api/placeholder/620/540"}
                          alt={item.title || item.type}
                          sx={{
                            width: "100%",
                            // ── FIX: Match the login card height exactly ──
                            height: CARD_HEIGHT,
                            objectFit: "cover",
                            display: "block",
                            filter: "brightness(0.6)",
                            transition: "filter 0.3s",
                            "&:hover": { filter: "brightness(0.5)" },
                          }}
                        />
                        <Box sx={{ position: "absolute", bottom: 0, width: "100%", background: "linear-gradient(0deg, rgba(0,0,0,0.78) 0%, transparent 100%)", p: "28px 20px 20px" }}>
                          <Chip
                            size="small"
                            label={getTypeLabel(item.type)}
                            icon={
                              item.type === "HOLIDAY"
                                ? <EventIcon sx={{ fontSize: "13px !important", color: "#fff !important" }} />
                                : item.type === "SUSPENSION"
                                ? <BlockIcon sx={{ fontSize: "13px !important", color: "#fff !important" }} />
                                : <AnnouncementIcon sx={{ fontSize: "13px !important", color: "#fff !important" }} />
                            }
                            sx={{
                              mb: 1,
                              bgcolor:
                                item.type === "HOLIDAY"
                                  ? "rgba(237,108,2,0.85)"
                                  : item.type === "SUSPENSION"
                                  ? "rgba(211,47,47,0.85)"
                                  : "rgba(128,0,32,0.85)",
                              color: "#fff",
                              fontWeight: 700,
                              fontSize: "0.62rem",
                              height: 20,
                              "& .MuiChip-icon": { color: "#fff" },
                            }}
                          />
                          <Typography variant="subtitle1" sx={{ color: "#fff", fontWeight: 700, lineHeight: 1.3, mb: 0.25 }}>
                            {item.title}
                          </Typography>
                          <Typography variant="body2" sx={{ color: "rgba(255,255,255,0.7)", fontSize: "0.78rem" }}>
                            {item.date ? new Date(item.date).toDateString() : ""}
                          </Typography>
                        </Box>
                      </Box>
                    ))}
                  </Box>
                </>
              ) : (
                <Typography sx={{ color: "rgba(255,255,255,0.4)", textAlign: "center" }}>
                  No announcements, holidays, or suspensions available
                </Typography>
              )}
            </Box>
          )}

          {/* ── RIGHT — Login / Forgot Password Card ────────────────────────── */}
          <Box sx={{ width: { xs: "100%", sm: 420 }, maxWidth: 420, flexShrink: 0 }}>
            <Box
              sx={{
                background: "rgba(255, 255, 255, 0.93)",
                backdropFilter: "blur(24px)",
                WebkitBackdropFilter: "blur(24px)",
                border: "1px solid rgba(200,180,180,0.35)",
                borderRadius: { xs: "16px", sm: "24px" },
                p: { xs: 2.25, sm: 4.5 },
                boxShadow: "0 24px 64px rgba(0,0,0,0.4)",
                position: "relative",
                overflow: "hidden",
                height: { xs: "auto", md: CARD_HEIGHT },
                minHeight: { xs: 340, sm: 460, md: "auto" },
                maxHeight: { xs: "none", md: CARD_HEIGHT },
                boxSizing: "border-box",
                display: "flex",
                flexDirection: "column",
              }}
            >
              {/* ── Login Panel ── */}
              <Box
                sx={{
                  position: { xs: "static", md: "absolute" },
                  inset: { md: "36px" },
                  display: showForgotPassword ? { xs: "none", md: "flex" } : "flex",
                  flexDirection: "column",
                  flex: { xs: 1, md: "unset" },
                  transition: "opacity 0.25s ease, transform 0.25s ease",
                  opacity: showForgotPassword ? 0 : 1,
                  transform: showForgotPassword ? "translateX(-24px)" : "translateX(0)",
                  pointerEvents: showForgotPassword ? "none" : "auto",
                }}
              >
                {/* Header */}
                <Box sx={{ mb: { xs: 1.5, sm: 4 }, textAlign: "center" }}>
                  <Typography sx={{ fontSize: { xs: "0.6rem", sm: "0.68rem" }, fontWeight: 700, letterSpacing: "0.22em", color: "rgba(128,0,32,0.55)", textTransform: "uppercase", mb: { xs: 0.4, sm: 0.75 } }}>
                    Welcome Back
                  </Typography>
                  <Typography sx={{ fontSize: { xs: "1.02rem", sm: "1.5rem" }, fontWeight: 800, color: crimsonDark, lineHeight: 1.2, letterSpacing: "-0.01em" }}>
                    Human Resources
                  </Typography>
                  <Typography sx={{ fontSize: { xs: "1.02rem", sm: "1.5rem" }, fontWeight: 800, color: crimsonDark, lineHeight: 1.2, letterSpacing: "-0.01em", mb: { xs: 0.25, sm: 0.5 } }}>
                    Information System
                  </Typography>
                  <Box sx={{ width: { xs: 32, sm: 44 }, height: 3, background: "linear-gradient(90deg, #800020, #e84a4a)", borderRadius: "2px", mx: "auto", mt: { xs: 0.75, sm: 1.5 } }} />
                </Box>

                <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                  <Box sx={{ mb: { xs: 1.5, sm: 2.5 } }}>
                    <Typography sx={{ fontSize: { xs: "0.62rem", sm: "0.7rem" }, fontWeight: 600, color: "rgba(75,0,0,0.55)", letterSpacing: "0.1em", textTransform: "uppercase", mb: { xs: 0.4, sm: 0.75 } }}>
                      Employee Number
                    </Typography>
                    <Box sx={{ position: "relative", display: "flex", alignItems: "center" }}>
                      <BadgeOutlined sx={{ position: "absolute", left: { xs: 12, sm: 14 }, color: "rgba(128,0,32,0.45)", fontSize: { xs: 16, sm: 18 }, zIndex: 1, pointerEvents: "none" }} />
                      <Box
                        component="input"
                        placeholder="Enter your employee number"
                        value={employeeNumber}
                        maxLength={20}
                        disabled={isLoginLocked}
                        onChange={handleEmployeeNumberChange}
                        sx={{ width: "100%", height: { xs: 42, sm: 50 }, pl: { xs: "38px", sm: "44px" }, pr: "16px", background: "rgba(255,255,255,0.8)", border: "1px solid rgba(128,0,32,0.18)", borderRadius: "12px", color: crimsonDark, fontSize: { xs: "0.82rem", sm: "0.9rem" }, outline: "none", transition: "border-color 0.2s, background 0.2s", fontFamily: "inherit", "&::placeholder": { color: "rgba(75,0,0,0.3)" }, "&:focus": { borderColor: "rgba(128,0,32,0.45)", background: "#fff" }, "&:disabled": { opacity: 0.45, cursor: "not-allowed" }, boxSizing: "border-box" }}
                      />
                    </Box>
                  </Box>

      <Box sx={{ mb: { xs: 0.6, sm: 1 } }}>
  <Typography
    sx={{
      fontSize: { xs: "0.62rem", sm: "0.7rem" },
      fontWeight: 600,
      color: "rgba(75,0,0,0.55)",
      letterSpacing: "0.1em",
      textTransform: "uppercase",
      mb: { xs: 0.4, sm: 0.75 },
    }}
  >
    Password
  </Typography>

  <Box sx={{ position: "relative", display: "flex", alignItems: "center" }}>
    <LockOutlined
      sx={{
        position: "absolute",
        left: { xs: 12, sm: 14 },
        color: "rgba(128,0,32,0.45)",
        fontSize: { xs: 16, sm: 18 },
        zIndex: 1,
        pointerEvents: "none",
      }}
    />

    <Box
      component="input"
      type="password"
      placeholder="Enter your password"
      name="password"
      disabled={isLoginLocked}
      onChange={handleChanges}
      sx={{
        width: "100%",
        height: { xs: 42, sm: 50 },
        pl: { xs: "38px", sm: "44px" },
        pr: "14px", // adjusted since right icon is removed
        background: "rgba(255,255,255,0.8)",
        border: "1px solid rgba(128,0,32,0.18)",
        borderRadius: "12px",
        color: crimsonDark,
        fontSize: { xs: "0.82rem", sm: "0.9rem" },
        outline: "none",
        transition: "border-color 0.2s, background 0.2s",
        fontFamily: "inherit",
        "&::placeholder": {
          color: "rgba(75,0,0,0.3)",
        },
        "&:focus": {
          borderColor: "rgba(128,0,32,0.45)",
          background: "#fff",
        },
        "&:disabled": {
          opacity: 0.45,
          cursor: "not-allowed",
        },
        boxSizing: "border-box",
      }}
    />
  </Box>
</Box>
                  <Typography sx={{ fontSize: { xs: "0.62rem", sm: "0.71rem" }, color: "rgba(128,0,32,0.45)", fontStyle: "italic", mb: { xs: 1.25, sm: 2.5 }, pl: 0.5 }}>
                    Default password must be entered in ALL CAPS with NO SPACES.
                  </Typography>

                  <Box sx={{ display: "flex", justifyContent: "flex-end", mb: { xs: 1.25, sm: 2.5 } }}>
                    <Link
                      component="button"
                      type="button"
                      onClick={() => setShowForgotPassword(true)}
                      underline="none"
                      sx={{ fontSize: { xs: "0.72rem", sm: "0.78rem" }, color: crimson, fontWeight: 500, transition: "color 0.2s", "&:hover": { color: crimsonDark }, background: "none", border: "none", cursor: "pointer" }}
                    >
                      Forgot password?
                    </Link>
                  </Box>

                  {(errMessage || dashWarning) && (
                    <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, p: "10px 14px", borderRadius: "10px", bgcolor: "rgba(200,30,30,0.04)", border: "1px solid rgba(200,30,30,0.12)", color: "#8a2020", fontSize: "0.8rem", mb: 2 }}>
                      <ErrorOutline sx={{ fontSize: 16, flexShrink: 0, mt: "1px" }} />
                      <Box>{errMessage || dashWarning}</Box>
                    </Box>
                  )}

                  <Box sx={{ flex: 1 }} />

                  <Box
                    component="button"
                    type="submit"
                    disabled={isLoginLocked}
                    sx={{ width: "100%", height: { xs: 44, sm: 52 }, background: isLoginLocked ? "rgba(128,0,32,0.15)" : "#800020", border: "none", borderRadius: "12px", color: "#fff", fontSize: { xs: "0.82rem", sm: "0.92rem" }, fontWeight: 600, letterSpacing: "0.05em", cursor: isLoginLocked ? "not-allowed" : "pointer", opacity: isLoginLocked ? 0.5 : 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", transition: "background 0.2s, opacity 0.2s", boxShadow: "none", fontFamily: "inherit", "&:hover:not(:disabled)": { background: "#6a001a", opacity: 0.92 }, "&:active:not(:disabled)": { background: "#5a0016" } }}
                  >
                    <LoginOutlined sx={{ fontSize: { xs: 16, sm: 18 } }} />
                    {isLoginLocked ? `Locked (${formatTime(loginLockTimer)})` : loading ? "Signing in…" : "Sign In"}
                  </Box>
                </form>
              </Box>

              {/* ── Forgot Password Panel ── */}
              <Box
                sx={{
                  position: { xs: "static", md: "absolute" },
                  inset: { md: "36px" },
                  display: showForgotPassword ? "flex" : { xs: "none", md: "flex" },
                  flexDirection: "column",
                  flex: { xs: 1, md: "unset" },
                  transition: "opacity 0.25s ease, transform 0.25s ease",
                  opacity: showForgotPassword ? 1 : 0,
                  transform: showForgotPassword ? "translateX(0)" : "translateX(24px)",
                  pointerEvents: showForgotPassword ? "auto" : "none",
                }}
              >
                <ForgotPasswordInline
                  onBack={() => setShowForgotPassword(false)}
                  crimson={crimson}
                  crimsonDark={crimsonDark}
                />
              </Box>
            </Box>
          </Box>
        </Box>

        {/* ── Intro Slide ─────────────────────────────────────────────────────── */}
        {showIntro && (
          <Box
            id="introSlide"
            onClick={() => {
              document.getElementById("introSlide").style.transform = "translateY(-100%)";
              setTimeout(() => setShowIntro(false), 800);
            }}
            sx={{ position: "fixed", top: 0, left: 0, width: "100%", height: "100%", zIndex: 9999, display: "flex", justifyContent: "center", alignItems: "center", background: "rgba(0, 0, 0, 0.35)", backdropFilter: "blur(15px)", borderRadius: 2, overflow: "hidden", transform: "translateY(0%)", transition: "transform 0.8s ease-in-out", cursor: "pointer", flexDirection: "column" }}
          >
            {blobs}
            <Box sx={{ textAlign: "center", px: 3, mb: 2 }} onClick={(e) => e.stopPropagation()}>
              <Typography sx={{ fontWeight: 900, mb: 2, fontSize: { xs: "2.4rem", sm: "3.5rem", md: "4.5rem", lg: "6rem" }, background: "linear-gradient(90deg, #bd7486ff, #e84a72ff)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", textShadow: "2px 2px 8px rgba(35, 1, 1, 0.7)" }}>H R I S</Typography>
              <Typography sx={{ fontWeight: 600, mb: 2, fontSize: { xs: "1.1rem", sm: "1.35rem", md: "1.5rem" }, color: "#FFFFFF", textShadow: "1px 1px 5px rgba(0,0,0,0.5)", px: 2 }}>Human Resources Information System</Typography>
            </Box>
            <Box sx={{ position: "absolute", bottom: { xs: 96, sm: 80 }, right: { xs: "50%", sm: 16 }, transform: { xs: "translateX(50%)", sm: "none" }, textAlign: { xs: "center", sm: "right" }, color: "#FFF8E7", px: 2 }} onClick={(e) => e.stopPropagation()}>
              <Typography sx={{ fontSize: { xs: "1.5rem", sm: "2.2rem" }, fontWeight: 500 }}>{currentTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</Typography>
              <Typography sx={{ fontSize: { xs: "0.8rem", sm: "1rem" }, fontWeight: 500 }}>{currentTime.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</Typography>
            </Box>
            <Box sx={{ position: "absolute", bottom: { xs: 55, sm: 55 }, right: { xs: "50%", sm: 16 }, transform: { xs: "translateX(50%)", sm: "none" }, display: "flex", justifyContent: "space-between", gap: { xs: 3, sm: 0 }, width: { xs: "auto", sm: "181px" }, color: "#FFF8E7", fontSize: "0.9rem" }}>
              <Link component="button" onClick={(e) => { e.stopPropagation(); setOpenPolicy(true); }} underline="hover" sx={{ color: "#FFF8E7", fontWeight: 500 }}>Privacy Policy</Link>
              <Link component="button" onClick={(e) => { e.stopPropagation(); setOpenFAQ(true); }} underline="hover" sx={{ color: "#FFF8E7", fontWeight: 500 }}>FAQs</Link>
            </Box>
            <Dialog open={openPolicy} onClose={() => setOpenPolicy(false)} fullWidth maxWidth="md">
              <Box p={3} position="relative">
                <IconButton onClick={(e) => { e.stopPropagation(); setOpenPolicy(false); }} sx={{ position: "absolute", top: 8, right: 8, color: "#6d2323" }}><CloseIcon /></IconButton>
                <Typography variant="h6" gutterBottom>Privacy Policy</Typography>
                <Typography variant="body2">This is the Privacy Policy content.</Typography>
              </Box>
            </Dialog>
            <Dialog open={openFAQ} onClose={() => setOpenFAQ(false)} fullWidth maxWidth="md">
              <Box p={3} position="relative">
                <IconButton onClick={(e) => { e.stopPropagation(); setOpenFAQ(false); }} sx={{ position: "absolute", top: 8, right: 8, color: "#6d2323" }}><CloseIcon /></IconButton>
                <Typography variant="h6" gutterBottom>FAQs</Typography>
                <Typography variant="body2">This is the FAQs content.</Typography>
              </Box>
            </Dialog>
            <IconButton
              onClick={() => {
                document.getElementById("introSlide").style.transform = "translateY(-100%)";
                setTimeout(() => setShowIntro(false), 800);
              }}
              sx={{ color: "#FFF8E7", fontSize: { xs: "2.2rem", sm: "3rem" }, animation: "bounce 2s infinite" }}
            >
              <KeyboardArrowDown fontSize="inherit" />
            </IconButton>
            <style>{`@keyframes bounce { 0%,100% { transform: translateY(0); } 50% { transform: translateY(15px); } }`}</style>
          </Box>
        )}

        {/* ── 2FA Modal ───────────────────────────────────────────────────────── */}
        <Modal open={show2FA} onClose={() => setShow2FA(false)}>
          <Box sx={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", p: { xs: 1.5, sm: 3 }, bgcolor: "rgba(0,0,0,0.6)" }}>
            <Box sx={{ width: "100%", maxWidth: 400, bgcolor: cream, borderRadius: "20px", px: { xs: 2, sm: 5 }, pt: { xs: 3.5, sm: 4.5 }, pb: { xs: 3, sm: 4 }, border: "0.5px solid rgba(128,0,32,0.15)", textAlign: "center" }}>
              <Box sx={{ width: 56, height: 56, borderRadius: "50%", bgcolor: "rgba(128,0,32,0.08)", display: "flex", alignItems: "center", justifyContent: "center", mx: "auto", mb: 2 }}>
                <VerifiedUserOutlined sx={{ color: crimson, fontSize: 26 }} />
              </Box>
              <Typography sx={{ fontSize: 18, fontWeight: 500, color: crimsonDark, mb: 0.75 }}>Email verification</Typography>
              <Typography sx={{ fontSize: 13, color: crimson, lineHeight: 1.5, mb: 3 }}>
                We sent a 6-digit code to<br />
                <Box component="span" sx={{ fontWeight: 500, color: crimsonDark }}>{maskEmail(userEmail)}</Box>
              </Typography>
              {success && (
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, textAlign: "left", p: "10px 12px", borderRadius: "8px", bgcolor: "#EAF3DE", border: "0.5px solid #9FE1CB", color: "#27500A", fontSize: 13, mb: 1.75 }}>
                  <CheckCircleOutline sx={{ fontSize: 16 }} />{success}
                </Box>
              )}
              {twoFactorError && (
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, textAlign: "left", p: "10px 12px", borderRadius: "8px", bgcolor: "#FCEBEB", border: "0.5px solid #F7C1C1", color: "#791F1F", fontSize: 13, mb: 1.75 }}>
                  <ErrorOutline sx={{ fontSize: 16 }} />{twoFactorError}
                </Box>
              )}
              <Box sx={{ display: "flex", justifyContent: "center", gap: { xs: 0.75, sm: 1.25 }, mb: 1.25 }}>
                {pinDigits.map((digit, index) => (
                  <Box
                    key={`pin-${index}`}
                    component="input"
                    ref={(el) => { pinInputRefs.current[index] = el; }}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    value={digit}
                    disabled={isLocked}
                    onChange={(e) => handlePinChange(index, e.target.value)}
                    onKeyDown={(e) => handlePinKeyDown(index, e)}
                    onPaste={handlePinPaste}
                    onFocus={(e) => e.target.select()}
                    sx={{ width: { xs: 36, sm: 52 }, height: { xs: 46, sm: 60 }, border: `1.5px solid ${digit ? crimson : "rgba(128,0,32,0.3)"}`, borderRadius: "10px", bgcolor: digit ? "rgba(128,0,32,0.04)" : "#fff", textAlign: "center", fontSize: { xs: 18, sm: 24 }, fontWeight: 500, color: crimsonDark, outline: "none", caretColor: crimson, transition: "border-color 0.15s, box-shadow 0.15s", fontFamily: "monospace", "&:focus": { borderColor: crimson, boxShadow: "0 0 0 3px rgba(128,0,32,0.12)" }, "&:disabled": { bgcolor: "rgba(128,0,32,0.04)", color: "rgba(75,0,0,0.45)", borderColor: "rgba(128,0,32,0.2)", cursor: "not-allowed" } }}
                  />
                ))}
              </Box>
              <Box sx={{ display: "flex", justifyContent: "center", gap: 0.75, mb: 2 }}>
                {pinDigits.map((digit, index) => (
                  <Box key={`dot-${index}`} sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: digit ? crimson : "rgba(128,0,32,0.18)", transition: "background 0.15s" }} />
                ))}
              </Box>
              <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 2.5, px: 0.25, flexWrap: "wrap", gap: 0.5 }}>
                <Typography sx={{ fontSize: 12, color: "#A32D2D" }}>{attemptMessage}</Typography>
                <Typography sx={{ fontSize: 12, color: codeExpireTimer <= 30 ? "#A32D2D" : crimson, fontWeight: 500 }}>
                  {codeExpireTimer > 0 ? `Code expires in ${formatTime(codeExpireTimer)}` : "Code expired"}
                </Typography>
              </Box>
              <Button fullWidth onClick={verify2FACode} disabled={twoFactorLoading || isLocked || codeExpireTimer <= 0 || pin.length < OTP_LENGTH}
                sx={{ mb: 1.5, py: 1.4, borderRadius: "10px", bgcolor: crimson, color: cream, textTransform: "none", fontSize: 14, fontWeight: 500, gap: 1, "&:hover": { bgcolor: crimsonDeep }, "&:disabled": { opacity: 0.45, color: cream } }}>
                <VerifiedUserOutlined sx={{ fontSize: 16 }} />
                {twoFactorLoading ? "Verifying..." : "Verify code"}
              </Button>
              <Button fullWidth variant="outlined" onClick={() => send2FACode(loginTicket, { isResend: true })} disabled={resendLoading || resendTimer > 0}
                sx={{ py: 1.2, px: 1.5, borderRadius: "10px", textTransform: "none", borderColor: "rgba(128,0,32,0.3)", color: crimson, fontSize: 13, gap: 1, "&:hover": { borderColor: "rgba(128,0,32,0.3)", bgcolor: "rgba(128,0,32,0.05)" }, "&:disabled": { bgcolor: "rgba(128,0,32,0.04)", borderColor: "rgba(128,0,32,0.15)", color: "rgba(128,0,32,0.4)" } }}>
                <AccessTimeIcon sx={{ fontSize: 14 }} />
                {resendLoading ? "Sending..." : resendTimer > 0 ? "Resend available in" : "Resend code"}
                {resendTimer > 0 && (
                  <Box component="span" sx={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 44, height: 22, px: 0.9, borderRadius: "20px", bgcolor: "rgba(128,0,32,0.1)", fontSize: 12, fontWeight: 500, fontFamily: "monospace" }}>
                    {formatTime(resendTimer)}
                  </Box>
                )}
              </Button>
              {resendTimer > 0 && (
                <Box sx={{ width: "100%", height: 3, bgcolor: "rgba(128,0,32,0.1)", borderRadius: "2px", mt: 0.8, overflow: "hidden" }}>
                  <Box sx={{ height: "100%", bgcolor: crimson, borderRadius: "2px", width: `${(resendTimer / OTP_RESEND_SECONDS) * 100}%`, transition: "width 1s linear" }} />
                </Box>
              )}
            </Box>
          </Box>
        </Modal>

        {/* ── Change Default Password Prompt ──────────────────────────────────── */}
        <Modal open={showPasswordPrompt} onClose={() => {}}>
          <Box sx={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: 560, maxWidth: "92%", maxHeight: "90vh", overflowY: "auto", bgcolor: "rgba(255,248,231,0.98)", borderRadius: 3, p: { xs: 2.5, sm: 4 }, backdropFilter: "blur(10px)", boxShadow: "0 20px 50px rgba(128,0,32,0.25)", border: "1px solid rgba(128,0,32,0.15)" }}>
            <Box sx={{ mb: 3, display: "flex", alignItems: "flex-start", gap: 2 }}>
              <Box sx={{ width: 48, height: 48, borderRadius: 2, background: "linear-gradient(135deg,#800020,#A52A2A)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <LockOutlined sx={{ fontSize: 28, color: cream }} />
              </Box>
              <Box sx={{ flex: 1 }}>
                <Typography variant="h6" sx={{ color: crimsonDark, fontWeight: 700, mb: 1, fontSize: { xs: "1.05rem", sm: "1.25rem" } }}>Password Security Notice</Typography>
                <Typography variant="body2" sx={{ color: crimson, lineHeight: 1.6 }}>Your account is currently using a default password. To protect the security and integrity of your account, you are required to create a new, unique password.</Typography>
              </Box>
            </Box>
            <Box sx={{ bgcolor: "rgba(255,152,0,0.08)", border: "1px solid rgba(255,152,0,0.3)", borderRadius: 2, p: { xs: 2, sm: 2.5 }, mb: 3 }}>
              <Typography variant="subtitle2" sx={{ color: "#e65100", fontWeight: 600, mb: 1, display: "flex", alignItems: "center", gap: 1 }}>
                <LockOutlined sx={{ fontSize: 18 }} /> Password Requirements
              </Typography>
              <Typography variant="body2" sx={{ color: "#5d4037", lineHeight: 1.7, fontSize: "0.9rem" }}>
                • Must be at least 8 characters long<br />
                • Must include both uppercase and lowercase letters<br />
                • Must contain at least one number and one special character<br />
                • Must not contain common words or personal information
              </Typography>
            </Box>
            <Box sx={{ display: "flex", flexDirection: { xs: "column", sm: "row" }, gap: 2, mb: 2 }}>
              <Button fullWidth variant="contained" sx={{ py: 1.5, background: "linear-gradient(135deg,#800020,#A52A2A)", fontWeight: 600, textTransform: "none", "&:hover": { background: "linear-gradient(135deg,#A52A2A,#800020)" } }} onClick={() => { window.location.href = "/settings?tab=security"; }} startIcon={<LockOutlined />}>
                Update Password Now
              </Button>
              <Button fullWidth variant="outlined" sx={{ py: 1.5, color: crimson, borderColor: crimson, fontWeight: 600, textTransform: "none", "&:hover": { backgroundColor: "rgba(128,0,32,0.05)", borderColor: crimson } }} onClick={() => { setShowPasswordPrompt(false); setShowLaterModal(true); }}>
                Remind Me Later
              </Button>
            </Box>
            <Typography variant="caption" sx={{ display: "block", color: "rgba(0,0,0,0.5)", fontSize: "0.75rem", textAlign: "center" }}>
              You can update your password at any time via Settings → Security → Change Password.
            </Typography>
          </Box>
        </Modal>

        {/* ── Later Modal ─────────────────────────────────────────────────────── */}
        <Modal open={showLaterModal} onClose={() => {}}>
          <Box sx={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: 520, maxWidth: "92%", maxHeight: "90vh", overflowY: "auto", bgcolor: "rgba(255,248,231,0.98)", borderRadius: 3, p: { xs: 2.5, sm: 4 }, backdropFilter: "blur(10px)", boxShadow: "0 20px 50px rgba(128,0,32,0.25)", border: "1px solid rgba(128,0,32,0.15)" }}>
            <Box sx={{ mb: 3, display: "flex", alignItems: "flex-start", gap: 2 }}>
              <Box sx={{ width: 48, height: 48, borderRadius: 2, background: "linear-gradient(135deg,#800020,#A52A2A)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <LockOutlined sx={{ fontSize: 28, color: cream }} />
              </Box>
              <Box sx={{ flex: 1 }}>
                <Typography variant="h6" sx={{ color: crimsonDark, fontWeight: 700, mb: 1, fontSize: { xs: "1.05rem", sm: "1.25rem" } }}>Password Update Reminder</Typography>
                <Typography variant="body2" sx={{ color: crimson, lineHeight: 1.6 }}>For security purposes, please update your password as soon as possible.</Typography>
              </Box>
            </Box>
            <Box sx={{ bgcolor: "rgba(128,0,32,0.05)", borderRadius: 2, p: { xs: 2, sm: 2.5 }, mb: 3, border: "1px solid rgba(128,0,32,0.1)" }}>
              <Typography variant="body2" sx={{ color: crimson, fontWeight: 600, mb: 0.5 }}>You can update your password at:</Typography>
              <Typography variant="body2" sx={{ color: crimsonDark, fontWeight: 600 }}>Settings → Security → Change Password</Typography>
            </Box>
            <Box sx={{ mb: 3, p: 2, bgcolor: "rgba(255,152,0,0.05)", borderRadius: 2, border: "1px solid rgba(255,152,0,0.15)" }}>
              <FormControlLabel
                control={<Checkbox checked={dontRemindToday} onChange={(e) => setDontRemindToday(e.target.checked)} sx={{ color: crimson, "&.Mui-checked": { color: crimson } }} />}
                label="Don't remind me again today"
                sx={{ margin: 0, "& .MuiFormControlLabel-label": { fontSize: "0.9rem", color: crimsonDark, fontWeight: 500 } }}
              />
            </Box>
            <Button
              fullWidth
              variant="contained"
              sx={{ py: 1.5, background: "linear-gradient(135deg,#800020,#A52A2A)", fontWeight: 600, textTransform: "none", "&:hover": { background: "linear-gradient(135deg,#A52A2A,#800020)" } }}
              onClick={() => {
                const token = localStorage.getItem("token");
                if (!token) return;
                const decoded = JSON.parse(atob(token.split(".")[1]));
                if (dontRemindToday) {
                  const reminderData = JSON.stringify({ date: new Date().toDateString(), employeeNumber: decoded.employeeNumber, timestamp: Date.now() });
                  localStorage.setItem("passwordReminderSkipped", reminderData);
                  sessionStorage.setItem("passwordReminderSkipped", reminderData);
                }
                setShowLaterModal(false);
                setTimeout(() => navigateToDashboard(decoded.role), 300);
              }}
            >
              Continue to Dashboard
            </Button>
          </Box>
        </Modal>
      </Box>
    </>
  );
};

export default Login;