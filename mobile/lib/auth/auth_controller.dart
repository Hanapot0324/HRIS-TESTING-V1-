import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import 'session.dart';

enum AuthStage { restoring, signedOut, otp, signedIn }

/// Drives the existing server login flow:
///   /login -> (/send-2fa-code -> /verify-2fa-code) -> /complete-2fa-login
/// The server decides whether an OTP is needed; the app never skips a step.
class AuthController extends ChangeNotifier {
  AuthController({
    required this._api,
    required this._store,
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now {
    _api.onSessionRejected = () =>
        signOut(notice: 'Your session has expired. Please sign in again.');
  }

  final ApiClient _api;
  final SessionStore _store;
  final DateTime Function() _clock;

  AuthStage _stage = AuthStage.restoring;
  Session? _session;
  String? _ticket;
  String? _maskedEmail;
  String? _notice;
  bool _busy = false;

  AuthStage get stage => _stage;
  Session? get session => _session;
  String? get maskedEmail => _maskedEmail;
  bool get busy => _busy;

  /// One-shot message for the sign-in screen (e.g. "session expired").
  String? takeNotice() {
    final n = _notice;
    _notice = null;
    return n;
  }

  Future<void> restore() async {
    Session? saved;
    try {
      saved = await _store.read();
    } on Object {
      saved = null;
    }
    if (saved != null && !saved.isExpired(_clock().toUtc())) {
      _session = saved;
      _api.token = saved.token;
      _stage = AuthStage.signedIn;
    } else {
      if (saved != null) {
        _notice = 'Your session has expired. Please sign in again.';
      }
      await _store.clear();
      _stage = AuthStage.signedOut;
    }
    notifyListeners();
  }

  /// Returns an error message, or null on success (signed in or OTP sent).
  Future<String?> signIn(String employeeNumber, String password) =>
      _run(() async {
        final res = await _api.post('/login', {
          'employeeNumber': employeeNumber.trim(),
          'password': password,
        }, authenticated: false) as Map<String, dynamic>;
        _ticket = res['loginTicket'] as String?;
        if (_ticket == null) {
          throw ApiException(
            ApiErrorKind.server,
            'This HRIS server does not support mobile sign-in yet.',
          );
        }
        _maskedEmail = maskEmail(res['email']?.toString() ?? '');
        await _completeOrRequestOtp();
      });

  Future<String?> resendCode() => _run(() async {
    await _api.post('/send-2fa-code', {
      'loginTicket': _requireTicket(),
    }, authenticated: false);
  });

  Future<String?> verifyCode(String code) => _run(() async {
    final res = await _api.post('/verify-2fa-code', {
      'loginTicket': _requireTicket(),
      'code': code.trim(),
    }, authenticated: false) as Map<String, dynamic>;
    _ticket = res['loginTicket'] as String?;
    await _completeOrRequestOtp();
  });

  void cancelOtp() {
    _ticket = null;
    _maskedEmail = null;
    _stage = AuthStage.signedOut;
    notifyListeners();
  }

  /// Clears the session from this device. (The backend has no logout
  /// endpoint yet; the token stops working when it expires server-side.)
  Future<void> signOut({String? notice}) async {
    if (_stage == AuthStage.signedOut && _session == null) return;
    _session = null;
    _ticket = null;
    _api.token = null;
    _notice = notice;
    _stage = AuthStage.signedOut;
    notifyListeners();
    await _store.clear();
  }

  Future<void> _completeOrRequestOtp() async {
    try {
      final data = await _api.post('/complete-2fa-login', {
        'loginTicket': _requireTicket(),
      }, authenticated: false) as Map<String, dynamic>;
      final session = Session.fromLoginResponse(data);
      await _store.write(session);
      _session = session;
      _ticket = null;
      _api.token = session.token;
      _stage = AuthStage.signedIn;
      notifyListeners();
    } on ApiException catch (e) {
      if (e.body?['mfaRequired'] == true && _stage != AuthStage.otp) {
        await _api.post('/send-2fa-code', {
          'loginTicket': _requireTicket(),
        }, authenticated: false);
        _stage = AuthStage.otp;
        notifyListeners();
        return;
      }
      rethrow;
    }
  }

  String _requireTicket() {
    final t = _ticket;
    if (t == null) {
      throw ApiException(
        ApiErrorKind.sessionExpired,
        'Login session expired. Please sign in again.',
      );
    }
    return t;
  }

  Future<String?> _run(Future<void> Function() action) async {
    if (_busy) return null;
    _busy = true;
    notifyListeners();
    try {
      await action();
      return null;
    } on ApiException catch (e) {
      return e.message;
    } on FormatException {
      return 'Unexpected response from the HRIS server.';
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  static String maskEmail(String email) {
    final at = email.indexOf('@');
    if (at <= 0) return '';
    final local = email.substring(0, at);
    final stars = '*' * (local.length - 1 < 4 ? 4 : local.length - 1);
    return '${local[0]}$stars${email.substring(at)}';
  }
}
