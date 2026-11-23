### Fixed

- `kit usage` no longer counts kit's own negative controls as refusals. Every `kit check` with the gates wired makes two gates refuse on purpose and logs both; since they are marked (`metadata.session_id: "kit-negative-control"`), the Floor tab shows them on a line of their own, "kit's own negative controls … not counted", and leaves them out of the audited and refused totals. Before, a repository where no agent had been refused anything showed "2 audited operations, 2 refused" after one `kit check`.
