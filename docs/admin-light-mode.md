# Admin Light Mode

All authenticated administrators use the existing Command White theme
(`light-command`). This is application policy, not a browser preference or a
business database setting. It applies equally to full and tracker-only admins.

## Behavior

- The theme is applied before React renders, including route-loading screens.
- Authentication, business-switch and browser-storage events resynchronize it.
- Saved dark preferences and late business-theme responses cannot darken admin.
- Employee theme choices and override flags are not overwritten by admin use.
- The business Themes settings remain employee defaults; labels now identify
  that scope. Saving one does not change administrator appearance.
- Shared admin styles strengthen muted labels and placeholders. Purple Add Lead
  and blue reassignment/edit actions retain readable contrasting text.

No database migration, production flag change or online deployment is needed
to publish the source. Existing deployed browsers do not receive this local code
until a separate deployment, which was not performed for this task.

## Verification

`backend/src/services/adminTheme.test.ts` covers a clean browser, stored dark
themes, overrides, multiple/new businesses, logout/login, authentication events,
late asynchronous settings, employee preference preservation and contrast tokens.
It reproduced the original default-dark behavior before the implementation.

Local browser checks used synthetic data: Dashboard, Reports, Tracker, Teams,
Employees, Leads, Tasks, HR, Attendance, Knowledge Base, Media, Messages,
Payroll, Credentials and Settings. Checks included the employee form, saving a
dark employee default, refresh, business switch, and signing in as an admin after
an employee saved Amethyst. Admin remained `light-command` with native
`color-scheme: light`. Solid-surface contrast checks identified and verified the
shared readability fixes; gradient actions were checked visually and against
their color tokens rather than treated as solid white backgrounds.

The same built frontend is served at localhost:5173 with the existing isolated
review copy. Separate synthetic browser checks do not alter that copy's records.
Physical testing of every browser/version and every future user-generated color
combination is not claimed.

Final local checks on October 20, 2026: backend suite 265 passed, zero failed or
skipped, with optional integration tests enabled against isolated Mongo. Full
lint, backend typecheck and frontend build passed. The existing large rich-text
editor bundle warning remains. Desktop 1440x1000 and mobile 390x844 were checked;
mobile viewport and page widths both measured 390 pixels. On localhost:5173,
switching through all three existing businesses and reloading retained
`light-command`, verified without reading employee records. Production was not
deployed or accessed. The earlier local overnight Shift Records correction is
included in the same requested GitHub source upload as a separate commit.
