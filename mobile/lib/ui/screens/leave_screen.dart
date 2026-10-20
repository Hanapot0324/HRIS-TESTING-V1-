import 'package:flutter/material.dart';

import '../../api/api_client.dart';
import '../../data/hris_repository.dart';
import '../../data/models.dart';
import '../theme.dart';
import '../widgets/async_body.dart';
import 'file_leave_screen.dart';

class LeaveScreen extends StatefulWidget {
  const LeaveScreen({super.key, required this.repo});

  final HrisRepository repo;

  @override
  State<LeaveScreen> createState() => _LeaveScreenState();
}

class _LeaveScreenState extends State<LeaveScreen> {
  final _balancesKey = GlobalKey<AsyncBodyState<List<LeaveBalance>>>();
  final _requestsKey = GlobalKey<AsyncBodyState<List<LeaveRequest>>>();

  Future<void> _fileLeave() async {
    final submitted = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => FileLeaveScreen(repo: widget.repo)),
    );
    if (submitted == true) {
      await Future.wait([
        _requestsKey.currentState?.reload() ?? Future.value(),
        _balancesKey.currentState?.reload() ?? Future.value(),
      ]);
    }
  }

  Future<void> _cancel(LeaveRequest r) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Cancel leave request?'),
        content: Text(
          '${r.description ?? r.leaveCode} on '
          '${r.leaveDate == null ? '—' : fmtDate.format(r.leaveDate!)} will be withdrawn.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Keep'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Cancel request'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    try {
      await widget.repo.cancelLeave(r.id);
      if (!mounted) return;
      showSnack(context, 'Leave request cancelled.');
    } on ApiException catch (e) {
      if (!mounted) return;
      showSnack(context, e.message);
    }
    await _requestsKey.currentState?.reload();
  }

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('My Leave'),
          bottom: const TabBar(
            tabs: [
              Tab(text: 'Requests'),
              Tab(text: 'Balances'),
            ],
          ),
        ),
        floatingActionButton: FloatingActionButton.extended(
          onPressed: _fileLeave,
          icon: const Icon(Icons.add),
          label: const Text('File leave'),
        ),
        body: TabBarView(
          children: [
            AsyncBody<List<LeaveRequest>>(
              key: _requestsKey,
              load: widget.repo.leaveRequests,
              isEmpty: (l) => l.isEmpty,
              emptyMessage: 'You have not filed any leave requests.',
              builder: (context, list, _) => ListView.separated(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
                itemCount: list.length,
                separatorBuilder: (_, _) => const SizedBox(height: 8),
                itemBuilder: (_, i) => _RequestCard(list[i], onCancel: _cancel),
              ),
            ),
            AsyncBody<List<LeaveBalance>>(
              key: _balancesKey,
              load: widget.repo.leaveBalances,
              isEmpty: (l) => l.isEmpty,
              emptyMessage: 'No leave credits are assigned to you.',
              builder: (context, list, _) => ListView(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
                children: [
                  Text(
                    'Balances are in hours, as computed by HR. Conversion to days '
                    'depends on your official schedule.',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  const SizedBox(height: 12),
                  for (final b in list) ...[
                    _BalanceCard(b),
                    const SizedBox(height: 8),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _RequestCard extends StatelessWidget {
  const _RequestCard(this.r, {required this.onCancel});

  final LeaveRequest r;
  final void Function(LeaveRequest) onCancel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    r.description ?? r.leaveCode,
                    style: theme.textTheme.titleSmall,
                  ),
                ),
                LeaveStatusChip(r.status),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              r.leaveDate == null ? '—' : fmtDayDate.format(r.leaveDate!),
              style: theme.textTheme.bodyMedium,
            ),
            if (r.createdAt != null)
              Text(
                'Filed ${fmtDate.format(r.createdAt!)}',
                style: theme.textTheme.bodySmall,
              ),
            if (r.status == LeaveStatus.denied && r.denialReason != null) ...[
              const SizedBox(height: 4),
              Text(
                'Reason: ${r.denialReason}',
                style: theme.textTheme.bodySmall,
              ),
            ],
            if (r.canCancel)
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  onPressed: () => onCancel(r),
                  child: const Text('Cancel request'),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class LeaveStatusChip extends StatelessWidget {
  const LeaveStatusChip(this.status, {super.key});

  final LeaveStatus status;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final (bg, fg) = switch (status) {
      LeaveStatus.hrApproved => (Colors.green.shade100, Colors.green.shade900),
      LeaveStatus.supervisorApproved => (
        Colors.blue.shade100,
        Colors.blue.shade900,
      ),
      LeaveStatus.denied => (scheme.errorContainer, scheme.onErrorContainer),
      LeaveStatus.pending => (Colors.orange.shade100, Colors.orange.shade900),
      _ => (scheme.surfaceContainerHighest, scheme.onSurfaceVariant),
    };
    return Chip(
      label: Text(status.label),
      labelStyle: TextStyle(color: fg, fontSize: 12),
      backgroundColor: bg,
      side: BorderSide.none,
      visualDensity: VisualDensity.compact,
    );
  }
}

class _BalanceCard extends StatelessWidget {
  const _BalanceCard(this.b);

  final LeaveBalance b;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final period = [
      b.periodYear,
      b.periodSemester,
    ].whereType<String>().join(' · ');
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              b.description ?? b.leaveCode,
              style: theme.textTheme.titleSmall,
            ),
            Text(
              [b.leaveCode, if (period.isNotEmpty) period].join(' · '),
              style: theme.textTheme.bodySmall,
            ),
            const SizedBox(height: 8),
            InfoRow('Remaining', fmtHours(b.remainingHours)),
            InfoRow('Used', fmtHours(b.usedHours)),
            InfoRow('Total', fmtHours(b.totalHours)),
          ],
        ),
      ),
    );
  }
}
