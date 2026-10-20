import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

/// EARIST maroon, matching the web HRIS (#6d2323).
const Color earistMaroon = Color(0xFF6D2323);

ThemeData buildTheme(Brightness brightness) {
  final scheme = ColorScheme.fromSeed(
    seedColor: earistMaroon,
    brightness: brightness,
  );
  return ThemeData(
    colorScheme: scheme,
    useMaterial3: true,
    inputDecorationTheme: const InputDecorationTheme(
      border: OutlineInputBorder(),
    ),
    cardTheme: const CardThemeData(margin: EdgeInsets.zero),
  );
}

final DateFormat fmtDate = DateFormat('MMM d, yyyy');
final DateFormat fmtDayDate = DateFormat('EEE, MMM d');
final DateFormat fmtMonth = DateFormat('MMMM yyyy');

/// Hours exactly as the server reports them, e.g. "12.5 hrs".
String fmtHours(double? h) {
  if (h == null) return '—';
  final s = h == h.roundToDouble()
      ? h.toStringAsFixed(0)
      : h.toStringAsFixed(2);
  return '$s hrs';
}

String orDash(String? s) => (s == null || s.isEmpty) ? '—' : s;
