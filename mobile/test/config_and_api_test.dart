import 'package:earist_hris_staff/api/api_client.dart';
import 'package:earist_hris_staff/config.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  group('AppConfig.baseUri', () {
    test('requires a URL', () {
      expect(() => AppConfig.baseUri(raw: ''), throwsStateError);
    });

    test('accepts https', () {
      expect(
        AppConfig.baseUri(raw: 'https://hris.example.test').host,
        'hris.example.test',
      );
    });

    test('rejects plain http for real hosts, even in debug', () {
      expect(
        () => AppConfig.baseUri(raw: 'http://hris.example.test', debug: true),
        throwsStateError,
      );
    });

    test('allows http to the local dev backend only in debug builds', () {
      expect(
        AppConfig.baseUri(raw: 'http://10.0.2.2:5000', debug: true).port,
        5000,
      );
      expect(
        () => AppConfig.baseUri(raw: 'http://10.0.2.2:5000', debug: false),
        throwsStateError,
      );
    });
  });

  group('ApiClient', () {
    late List<http.Request> sent;
    ApiClient clientReturning(int status, String body) {
      sent = [];
      return ApiClient(
        baseUri: Uri.parse('https://hris.example.test'),
        httpClient: MockClient((req) async {
          sent.add(req);
          return http.Response(body, status);
        }),
      );
    }

    test('attaches the bearer token to authenticated calls only', () async {
      final api = clientReturning(200, '{}')..token = 'tok';
      await api.get('/api/me/profile');
      await api.post('/login', {'a': 1}, authenticated: false);
      expect(sent[0].headers['Authorization'], 'Bearer tok');
      expect(sent[1].headers.containsKey('Authorization'), isFalse);
    });

    test(
      'refuses an authenticated call with no session, without sending it',
      () async {
        final api = clientReturning(200, '{}');
        await expectLater(
          api.get('/api/me/profile'),
          throwsA(
            isA<ApiException>().having(
              (e) => e.kind,
              'kind',
              ApiErrorKind.sessionExpired,
            ),
          ),
        );
        expect(sent, isEmpty);
      },
    );

    for (final (status, body) in [
      (401, '{"error":"No token provided"}'),
      (403, '{"error":"Invalid token"}'),
    ]) {
      test(
        '$status token rejection -> sessionExpired + sign-out callback',
        () async {
          var rejected = 0;
          final api =
              clientReturning(status, body)
                ..token = 'tok'
                ..onSessionRejected = () => rejected++;
          await expectLater(
            api.get('/api/me/profile'),
            throwsA(
              isA<ApiException>().having(
                (e) => e.kind,
                'kind',
                ApiErrorKind.sessionExpired,
              ),
            ),
          );
          expect(rejected, 1);
        },
      );
    }

    test('ownership 403 is access denied, not a sign-out', () async {
      var rejected = 0;
      final api =
          clientReturning(403, '{"error":"Access denied"}')
            ..token = 'tok'
            ..onSessionRejected = () => rejected++;
      await expectLater(
        api.get('/leaveRoute/leave_request/1002'),
        throwsA(
          isA<ApiException>().having(
            (e) => e.kind,
            'kind',
            ApiErrorKind.accessDenied,
          ),
        ),
      );
      expect(rejected, 0);
    });

    test('server errors do not leak server-side details', () async {
      final api = clientReturning(
        500,
        '{"error":"ER_NO_SUCH_TABLE: hris.leave_x"}',
      )..token = 'tok';
      await expectLater(
        api.get('/api/me/profile'),
        throwsA(
          isA<ApiException>()
              .having((e) => e.kind, 'kind', ApiErrorKind.server)
              .having((e) => e.message, 'message', isNot(contains('ER_'))),
        ),
      );
    });

    test('network failure becomes a friendly network error', () async {
      final api = ApiClient(
        baseUri: Uri.parse('https://hris.example.test'),
        httpClient: MockClient((_) async => throw http.ClientException('boom')),
      )..token = 'tok';
      await expectLater(
        api.get('/api/me/profile'),
        throwsA(
          isA<ApiException>().having(
            (e) => e.kind,
            'kind',
            ApiErrorKind.network,
          ),
        ),
      );
    });
  });
}
