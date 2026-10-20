import 'package:flutter/material.dart';

import '../../api/api_client.dart';
import '../../data/hris_repository.dart';
import '../../data/models.dart';
import '../theme.dart';
import '../widgets/async_body.dart';

/// Files a leave request through the existing workflow. Eligibility,
/// deductions and approval all happen server-side / by HR — this screen only
/// collects the leave type and dates and reports what the server said.
class FileLeaveScreen extends StatefulWidget {
  const FileLeaveScreen({super.key, required this.repo});

  final HrisRepository repo;

  @override
  State<FileLeaveScreen> createState() => _FileLeaveScreenState();
}

class _FileLeaveScreenState extends State<FileLeaveScreen> {
  String? _leaveCode;
  final List<DateTime> _dates = [];
  bool _submitting = false;
  String? _error;

  Future<void> _addDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _dates.isEmpty
          ? now
          : _dates.last.add(const Duration(days: 1)),
      firstDate: DateTime(now.year - 1),
      lastDate: DateTime(now.year + 1, 12, 31),
      helpText: 'Select a leave date',
    );
    if (picked == null) return;
    setState(() {
      if (!_dates.any((d) => DateUtils.isSameDay(d, picked))) {
        _dates.add(picked);
      }
      _dates.sort();
      _error = null;
    });
  }

  Future<void> _submit(List<LeaveType> types) async {
    if (_leaveCode == null) {
      setState(() => _error = 'Select a leave type.');
      return;
    }
    if (_dates.isEmpty) {
      setState(() => _error = 'Add at least one date.');
      return;
    }
    final type = types.firstWhere((t) => t.code == _leaveCode);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Submit leave request?'),
        content: Text(
          '${type.description}\n'
          '${_dates.length} day${_dates.length == 1 ? '' : 's'}: '
          '${_dates.map(fmtDate.format).join(', ')}\n\n'
          'Your request will be reviewed. Credits are only deducted once approved.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Back'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Submit'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await widget.repo.submitLeave(_leaveCode!, _dates);
      if (!mounted) return;
      // Only report success after the server confirmed it.
      showSnack(context, 'Leave request submitted.');
      Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('File leave')),
      body: AsyncBody<List<LeaveType>>(
        load: widget.repo.leaveTypes,
        isEmpty: (l) => l.isEmpty,
        emptyMessage: 'No leave types are available to you. Contact HR.',
        builder: (context, types, _) {
          final theme = Theme.of(context);
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              DropdownButtonFormField<String>(
                initialValue: _leaveCode,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Leave type'),
                items: [
                  for (final t in types)
                    DropdownMenuItem(
                      value: t.code,
                      child: Text(
                        '${t.description} (${t.code})',
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                ],
                onChanged: _submitting
                    ? null
                    : (v) => setState(() => _leaveCode = v),
              ),
              const SizedBox(height: 24),
              Row(
                children: [
                  Expanded(
                    child: Text('Dates', style: theme.textTheme.titleMedium),
                  ),
                  TextButton.icon(
                    onPressed: _submitting ? null : _addDate,
                    icon: const Icon(Icons.add),
                    label: const Text('Add date'),
                  ),
                ],
              ),
              if (_dates.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 8),
                  child: Text('No dates selected.'),
                )
              else
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final d in _dates)
                      InputChip(
                        label: Text(fmtDayDate.format(d)),
                        onDeleted: _submitting
                            ? null
                            : () => setState(() => _dates.remove(d)),
                        deleteButtonTooltipMessage: 'Remove date',
                      ),
                  ],
                ),
              if (_error != null) ...[
                const SizedBox(height: 16),
                Text(_error!, style: TextStyle(color: theme.colorScheme.error)),
              ],
              const SizedBox(height: 24),
              FilledButton(
                onPressed: _submitting ? null : () => _submit(types),
                style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(48),
                ),
                child: _submitting
                    ? const SizedBox(
                        height: 20,
                        width: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('Review & submit'),
              ),
              const SizedBox(height: 12),
              Text(
                'Eligibility and the hours charged are determined by HR under '
                'existing rules. Supporting documents (e.g. medical certificates) '
                'are submitted through HR.',
                style: theme.textTheme.bodySmall,
              ),
            ],
          );
        },
      ),
    );
  }
}
