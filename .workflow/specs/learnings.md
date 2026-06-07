<spec-entry category="learning" keywords="fixture-redaction,repeated-references,read-models,status-normalization,siteflow" date="2026-05-15" source=".workflow/scratch/ui-design-siteflow-20260515/.summaries/TASK-006-summary.md">

### Normalize Redacted Fixture References

When fixture-backed read models use deep redaction, repeated object references can be replaced by redaction placeholders. Page components should normalize fallback data before rendering critical status labels, especially for deployment lineage, release safety checks, and rollback target state. Keep redaction centralized, but add feature-local normalization when duplicate fixture references are collapsed.

</spec-entry>
