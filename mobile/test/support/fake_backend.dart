import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// Builds an unsigned JWT-shaped token with the given expiry (tests only).
String fakeJwt({required DateTime exp, String employeeNumber = '1001'}) {
  String part(Map<String, dynamic> m) =>
      base64Url.encode(utf8.encode(jsonEncode(m))).replaceAll('=', '');
  return '${part({'alg': 'HS256'})}.'
      '${part({'employeeNumber': employeeNumber, 'exp': exp.millisecondsSinceEpoch ~/ 1000})}'
      '.sig';
}

/// Minimal stand-in for the HRIS backend, with synthetic data only.
/// Records every request so tests can assert exactly what the app sent.
class FakeBackend {
  FakeBackend({this.mfaRequired = true});

  bool mfaRequired;
  final List<http.Request> requests = [];
  String password = 'Correct#Pass1';
  String otp = '123456';
  late String token = fakeJwt(
    exp: DateTime.now().add(const Duration(hours: 10)),
  );

  /// Per-path overrides: path -> response.
  final Map<String, http.Response Function(http.Request)> routes = {};

  late final MockClient client = MockClient((req) async {
    requests.add(req);
    final override = routes[req.url.path];
    if (override != null) return override(req);
    return _default(req);
  });

  http.Response json(Object? body, [int status = 200]) => http.Response(
    jsonEncode(body),
    status,
    headers: {'content-type': 'application/json'},
  );

  Map<String, dynamic> _body(http.Request r) =>
      r.body.isEmpty ? {} : jsonDecode(r.body) as Map<String, dynamic>;

  http.Response _default(http.Request req) {
    final b = _body(req);
    switch (req.url.path) {
      case '/login':
        if (b['employeeNumber'] == '1001' && b['password'] == password) {
          return json({
            'email': 'ana.staff@example.test',
            'employeeNumber': '1001',
            'fullName': 'Ana Staff',
            'loginTicket': 'ticket-password',
          });
        }
        return json({'message': 'Invalid credentials'}, 400);
      case '/send-2fa-code':
        return b['loginTicket'] == 'ticket-password'
            ? json({'message': 'Verification code sent'})
            : json({
              'error': 'Login session expired. Please sign in again.',
            }, 401);
      case '/verify-2fa-code':
        if (b['code'] == otp) {
          return json({'verified': true, 'loginTicket': 'ticket-mfa'});
        }
        return json({'error': 'Invalid code'}, 400);
      case '/complete-2fa-login':
        final t = b['loginTicket'];
        if (t == 'ticket-mfa' || (t == 'ticket-password' && !mfaRequired)) {
          return json({
            'token': token,
            'role': 'staff',
            'employeeNumber': '1001',
            'username': 'Ana Staff',
            'firstName': 'Ana',
            'isDefaultPassword': false,
          });
        }
        if (t == 'ticket-password') {
          return json({
            'error': 'Verification code required.',
            'mfaRequired': true,
          }, 401);
        }
        return json({
          'error': 'Login session expired. Please sign in again.',
        }, 401);
    }
    return json({'error': 'Not found'}, 404);
  }
}
