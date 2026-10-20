import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

enum ApiErrorKind {
  network,
  sessionExpired,
  accessDenied,
  invalidRequest,
  notFound,
  conflict,
  server,
}

class ApiException implements Exception {
  ApiException(this.kind, this.message, {this.statusCode, this.body});

  final ApiErrorKind kind;

  /// User-facing message. Never contains tokens, passwords or OTPs.
  final String message;
  final int? statusCode;
  final Map<String, dynamic>? body;

  @override
  String toString() => message;
}

/// Thin JSON client for the HRIS backend.
///
/// The backend is the security boundary: this client only attaches the
/// session token and turns HTTP failures into typed, user-safe errors. It
/// never logs request/response bodies (they can hold personal data or tokens).
class ApiClient {
  ApiClient({
    required this.baseUri,
    http.Client? httpClient,
    this.timeout = const Duration(seconds: 20),
  }) : _http = httpClient ?? http.Client();

  final Uri baseUri;
  final http.Client _http;
  final Duration timeout;
  String? _token;

  /// Invoked when the server rejects the stored session token (expired,
  /// revoked or invalid), so the app can sign out.
  void Function()? onSessionRejected;

  set token(String? value) => _token = value;
  bool get hasToken => _token != null;

  Future<dynamic> get(
    String path, {
    Map<String, String>? query,
    bool authenticated = true,
  }) => _send('GET', path, query: query, authenticated: authenticated);

  Future<dynamic> post(
    String path,
    Object? body, {
    bool authenticated = true,
  }) => _send('POST', path, body: body, authenticated: authenticated);

  Future<dynamic> put(String path, Object? body, {bool authenticated = true}) =>
      _send('PUT', path, body: body, authenticated: authenticated);

  Uri _uri(String path, Map<String, String>? query) {
    var basePath = baseUri.path;
    if (basePath.endsWith('/')) {
      basePath = basePath.substring(0, basePath.length - 1);
    }
    return baseUri.replace(
      path: '$basePath$path',
      queryParameters: (query == null || query.isEmpty) ? null : query,
    );
  }

  Future<dynamic> _send(
    String method,
    String path, {
    Map<String, String>? query,
    Object? body,
    required bool authenticated,
  }) async {
    final headers = <String, String>{'Accept': 'application/json'};
    if (body != null) headers['Content-Type'] = 'application/json';
    if (authenticated) {
      final token = _token;
      if (token == null) {
        throw ApiException(
          ApiErrorKind.sessionExpired,
          'Please sign in again.',
        );
      }
      headers['Authorization'] = 'Bearer $token';
    }

    final http.Response res;
    try {
      final req = http.Request(method, _uri(path, query))
        ..headers.addAll(headers);
      if (body != null) req.body = jsonEncode(body);
      res = await http.Response.fromStream(
        await _http.send(req).timeout(timeout),
      );
    } on TimeoutException {
      throw ApiException(
        ApiErrorKind.network,
        'The HRIS server took too long to respond. Please try again.',
      );
    } on http.ClientException {
      throw ApiException(
        ApiErrorKind.network,
        'Cannot reach the HRIS server. Check your connection.',
      );
    }

    final decoded = _decode(res.body);
    if (res.statusCode >= 200 && res.statusCode < 300) return decoded;
    throw _toException(
      res.statusCode,
      decoded is Map<String, dynamic> ? decoded : null,
      authenticated: authenticated,
    );
  }

  static dynamic _decode(String text) {
    if (text.isEmpty) return null;
    try {
      return jsonDecode(text);
    } on FormatException {
      return null;
    }
  }

  ApiException _toException(
    int status,
    Map<String, dynamic>? body, {
    required bool authenticated,
  }) {
    final serverMessage = (body?['error'] ?? body?['message']);
    final msg =
        serverMessage is String && serverMessage.trim().isNotEmpty
            ? serverMessage.trim()
            : null;

    // authenticateToken: 401 = no token, 403 'Invalid token' = bad/expired.
    final tokenRejected =
        authenticated &&
        (status == 401 || (status == 403 && msg == 'Invalid token'));
    if (tokenRejected) {
      onSessionRejected?.call();
      return ApiException(
        ApiErrorKind.sessionExpired,
        'Your session has expired. Please sign in again.',
        statusCode: status,
        body: body,
      );
    }

    switch (status) {
      case 400:
      case 401:
      case 422:
        return ApiException(
          ApiErrorKind.invalidRequest,
          msg ?? 'The request was not valid.',
          statusCode: status,
          body: body,
        );
      case 403:
        return ApiException(
          ApiErrorKind.accessDenied,
          msg ?? 'You do not have access to this information.',
          statusCode: status,
          body: body,
        );
      case 404:
        return ApiException(
          ApiErrorKind.notFound,
          'Not found.',
          statusCode: status,
          body: body,
        );
      case 409:
        return ApiException(
          ApiErrorKind.conflict,
          msg ?? 'This record was changed elsewhere. Please refresh.',
          statusCode: status,
          body: body,
        );
      default:
        // Server error text can contain internals; show a generic message.
        return ApiException(
          ApiErrorKind.server,
          'Something went wrong on the server. Please try again later.',
          statusCode: status,
          body: body,
        );
    }
  }
}
