import 'package:flutter/material.dart';

import '../../data/hris_repository.dart';
import '../../data/models.dart';
import '../theme.dart';
import '../widgets/async_body.dart';

enum DtrHalf { first, second, whole }

/// Date range for a DTR period: 1st–15th, 16th–end of month, or whole month.
DateTimeRange dtrRange(DateTime month, DtrHalf half) {
  final lastDay = DateUtils.getDaysInMonth(month.year, month.month);
  final start = DateTime(
    month.year,
    month.month,
    half == DtrHalf.second ? 16 : 1,
  );
  final end = DateTime(
    month.year,
    month.month,
    half == DtrHalf.first ? 15 : lastDay,
  );
  return DateTimeRange(start: start, end: end);
}

class DtrScreen extends StatefulWidget {
  const DtrScreen({super.key, required this.repo, this.now});

  final HrisRepository repo;
  final DateTime Function()? now;

  @override
  State<DtrScreen> createState() => _DtrScreenState();
}

class _DtrScreenState extends State<DtrScreen> {
  late DateTime _month;
  late DtrHalf _half;

  @override
  void initState() {
    super.initState();
    final today = (widget.now ?? DateTime.now)();
    _month = DateTime(today.year, today.month);
    _half = today.day <= 15 ? DtrHalf.first : DtrHalf.second;
  }

  void _shiftMonth(int delta) =>
      setState(() => _month = DateTime(_month.year, _month.month + delta));

  @override
  Widget build(BuildContext context) {
    final range = dtrRange(_month, _half);
    return Scaffold(
      appBar: AppBar(title: const Text('My Daily Time Record')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 8, 8, 0),
            child: Row(
              children: [
                IconButton(
                  tooltip: 'Previous month',
                  icon: const Icon(Icons.chevron_left),
                  onPressed: () => _shiftMonth(-1),
                ),
                Expanded(
                  child: Text(
                    fmtMonth.format(_month),
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                IconButton(
                  tooltip: 'Next month',
                  icon: const Icon(Icons.chevron_right),
                  onPressed: () => _shiftMonth(1),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: SegmentedButton<DtrHalf>(
              segments: [
                const ButtonSegment(value: DtrHalf.first, label: Text('1–15')),
                ButtonSegment(
                  value: DtrHalf.second,
                  label: Text(
                    '16–${DateUtils.getDaysInMonth(_month.year, _month.month)}',
                  ),
                ),
                const ButtonSegment(
                  value: DtrHalf.whole,
                  label: Text('Whole month'),
                ),
              ],
              selected: {_half},
              onSelectionChanged: (s) => setState(() => _half = s.first),
            ),
          ),
          Expanded(
            child: AsyncBody<List<DtrRecord>>(
              key: ValueKey('${range.start}-${range.end}'),
              load: () => widget.repo.dtr(range.start, range.end),
              isEmpty: (rows) => rows.isEmpty,
              emptyMessage: 'No attendance records for this period.',
              builder: (context, rows, _) => ListView.separated(
                padding: const EdgeInsets.all(16),
                itemCount: rows.length,
                separatorBuilder: (_, _) => const SizedBox(height: 8),
                itemBuilder: (_, i) => _DtrCard(rows[i]),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _DtrCard extends StatelessWidget {
  const _DtrCard(this.r);

  final DtrRecord r;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(fmtDayDate.format(r.date), style: theme.textTheme.titleSmall),
            const SizedBox(height: 8),
            Row(
              children: [
                _Cell('Time in', r.timeIn),
                // Same labels/order as the web DTR (breaktimeIN, breaktimeOUT).
                _Cell('Break in', r.breakIn),
                _Cell('Break out', r.breakOut),
                _Cell('Time out', r.timeOut),
              ],
            ),
            if (r.officialIn != null || r.officialOut != null) ...[
              const SizedBox(height: 8),
              Text(
                'Official time: ${orDash(r.officialIn)} – ${orDash(r.officialOut)}',
                style: theme.textTheme.bodySmall,
              ),
            ],
            if (r.remarks != null) ...[
              const SizedBox(height: 4),
              Text('Remarks: ${r.remarks}', style: theme.textTheme.bodySmall),
            ],
          ],
        ),
      ),
    );
  }
}

class _Cell extends StatelessWidget {
  const _Cell(this.label, this.value);

  final String label;
  final String? value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: theme.textTheme.labelSmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          Text(orDash(value), style: theme.textTheme.bodyMedium),
        ],
      ),
    );
  }
}
