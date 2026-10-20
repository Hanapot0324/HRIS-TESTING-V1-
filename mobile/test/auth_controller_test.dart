import 'dart:convert';

import 'package:earist_hris_staff/api/api_client.dart';
import 'package:earist_hris_staff/auth/auth_controller.dart';
import 'package:earist_hris_staff/auth/session.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_backend.dart';

void main() {
  late FakeBackend backend;
  late ApiClient api;
  late MemorySessionStore store;
  late AuthController auth;

  void build({bool mfa = true}) {
    backend = FakeBackend(mfaRequired: mfa);
    api = ApiClient(
      baseUri: Uri.parse('https://hris.example.test'),
      httpClient: backend.client,
    );
    store = MemorySessionStore();
    auth = AuthController(api: api, store: store);
  }

  List<String> paths() => backend.requests.map((r) => r.url.path).toList();

  test(
    'wrong password shows the server message and stays signed out',
    () async {
      build();
      await auth.restore();
      final err = await auth.signIn('1001', 'nope');
      expect(err, 'Invalid credentials');
      expect(auth.stage, AuthStage.signedOut);
      expect(store.value, isNull);
    },
  );

  test('MFA on: password -> OTP -> signed in; token stored securely', () async {
    build();
    await auth.restore();
    expect(await auth.signIn('1001', 'Correct#Pass1'), isNull);
    expect(auth.stage, AuthStage.otp);
    expect(
      auth.maskedEmail,
      'a********@example.test',
    ); // same rule as web Login.jsx
    expect(paths(), ['/login', '/complete-2fa-login', '/send-2fa-code']);

    expect(await auth.verifyCode('000000'), 'Invalid code');
    expect(auth.stage, AuthStage.otp);

    expect(await auth.verifyCode('123456'), isNull);
    expect(auth.stage, AuthStage.signedIn);
    expect(auth.session!.employeeNumber, '1001');
    expect(store.value!.token, backend.token);
    expect(api.hasToken, isTrue);

    // The OTP-upgraded ticket, not the password ticket, completes the login.
    final complete = backend.requests.lastWhere(
      (r) => r.url.path == '/complete-2fa-login',
    );
    expect(jsonDecode(complete.body), {'loginTicket': 'ticket-mfa'});
  });

  test('password is only ever sent to /login', () async {
    build();
    await auth.signIn('1001', 'Correct#Pass1');
    await auth.verifyCode('123456');
    final withPassword = backend.requests.where(
      (r) => r.body.contains('Correct#Pass1'),
    );
    expect(withPassword.map((r) => r.url.path), ['/login']);
  });

  test('MFA off on the server: signs in without an OTP step', () async {
    build(mfa: false);
    expect(await auth.signIn('1001', 'Correct#Pass1'), isNull);
    expect(auth.stage, AuthStage.signedIn);
    expect(paths(), ['/login', '/complete-2fa-login']);
  });

  test('restore keeps a valid saved session', () async {
    build();
    store.value = Session(
      token: backend.token,
      employeeNumber: '1001',
      displayName: 'Ana',
      isDefaultPassword: false,
      expiresAt: DateTime.now().toUtc().add(const Duration(hours: 1)),
    );
    await auth.restore();
    expect(auth.stage, AuthStage.signedIn);
    expect(backend.requests, isEmpty);
  });

  test('restore drops an expired session and explains why', () async {
    build();
    store.value = Session(
      token: 'old',
      employeeNumber: '1001',
      displayName: 'Ana',
      isDefaultPassword: false,
      expiresAt: DateTime.now().toUtc().subtract(const Duration(minutes: 1)),
    );
    await auth.restore();
    expect(auth.stage, AuthStage.signedOut);
    expect(store.value, isNull);
    expect(auth.takeNotice(), contains('expired'));
  });

  test(
    'server rejecting the token signs the user out and clears storage',
    () async {
      build(mfa: false);
      await auth.signIn('1001', 'Correct#Pass1');
      backend.routes['/api/me/profile'] =
          (_) => backend.json({'error': 'Invalid token'}, 403);
      await expectLater(
        api.get('/api/me/profile'),
        throwsA(isA<ApiException>()),
      );
      await Future<void>.delayed(Duration.zero);
      expect(auth.stage, AuthStage.signedOut);
      expect(store.value, isNull);
      expect(api.hasToken, isFalse);
      expect(auth.takeNotice(), contains('expired'));
    },
  );

  test('sign out clears the token from the device', () async {
    build(mfa: false);
    await auth.signIn('1001', 'Correct#Pass1');
    await auth.signOut();
    expect(auth.stage, AuthStage.signedOut);
    expect(store.value, isNull);
    expect(api.hasToken, isFalse);
  });

  test('Session.jwtExpiry reads exp', () {
    final exp = DateTime.utc(2030, 1, 1);
    expect(Session.jwtExpiry(fakeJwt(exp: exp)), exp);
    expect(Session.jwtExpiry('not-a-jwt'), isNull);
  });
}
