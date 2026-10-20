import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// The signed-in employee's session, as returned by /complete-2fa-login.
class Session {
  const Session({
    required this.token,
    required this.employeeNumber,
    required this.displayName,
    required this.isDefaultPassword,
    this.expiresAt,
  });

  final String token;
  final String employeeNumber;
  final String displayName;
  final bool isDefaultPassword;

  /// From the JWT `exp` claim — used only to avoid sending a token we know is
  /// stale. The server still validates every request.
  final DateTime? expiresAt;

  bool isExpired(DateTime now) =>
      expiresAt != null && !now.isBefore(expiresAt!);

  factory Session.fromLoginResponse(Map<String, dynamic> json) {
    final token = json['token'];
    final emp = json['employeeNumber'];
    if (token is! String || token.isEmpty || emp == null) {
      throw const FormatException('Login response is missing token data.');
    }
    final first = (json['firstName'] ?? '').toString().trim();
    final full = (json['username'] ?? '').toString().trim();
    return Session(
      token: token,
      employeeNumber: emp.toString(),
      displayName: first.isNotEmpty ? first : full,
      isDefaultPassword: json['isDefaultPassword'] == true,
      expiresAt: jwtExpiry(token),
    );
  }

  Map<String, dynamic> toJson() => {
    'token': token,
    'employeeNumber': employeeNumber,
    'displayName': displayName,
    'isDefaultPassword': isDefaultPassword,
    'expiresAt': expiresAt?.toIso8601String(),
  };

  factory Session.fromJson(Map<String, dynamic> json) => Session(
    token: json['token'] as String,
    employeeNumber: json['employeeNumber'] as String,
    displayName: (json['displayName'] ?? '') as String,
    isDefaultPassword: json['isDefaultPassword'] == true,
    expiresAt:
        json['expiresAt'] == null
            ? null
            : DateTime.tryParse(json['expiresAt'] as String),
  );

  /// Reads `exp` from a JWT payload without verifying it (display/UX only).
  static DateTime? jwtExpiry(String token) {
    final parts = token.split('.');
    if (parts.length != 3) return null;
    try {
      final payload = jsonDecode(
        utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))),
      );
      final exp = payload is Map ? payload['exp'] : null;
      if (exp is num) {
        return DateTime.fromMillisecondsSinceEpoch(
          exp.toInt() * 1000,
          isUtc: true,
        );
      }
    } on FormatException {
      return null;
    }
    return null;
  }
}

abstract class SessionStore {
  Future<Session?> read();
  Future<void> write(Session session);
  Future<void> clear();
}

/// Keeps the session in the OS keystore (Android Keystore / iOS Keychain).
class SecureSessionStore implements SessionStore {
  SecureSessionStore([FlutterSecureStorage? storage])
    : _storage = storage ?? const FlutterSecureStorage();

  static const _key = 'hris_session';
  final FlutterSecureStorage _storage;

  @override
  Future<Session?> read() async {
    final raw = await _storage.read(key: _key);
    if (raw == null) return null;
    try {
      return Session.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } on Object {
      await clear();
      return null;
    }
  }

  @override
  Future<void> write(Session session) =>
      _storage.write(key: _key, value: jsonEncode(session.toJson()));

  @override
  Future<void> clear() => _storage.delete(key: _key);
}

/// In-memory store for tests.
class MemorySessionStore implements SessionStore {
  Session? value;

  @override
  Future<Session?> read() async => value;

  @override
  Future<void> write(Session session) async => value = session;

  @override
  Future<void> clear() async => value = null;
}
