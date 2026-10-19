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

## Full Tab Readability Follow-Up

The follow-up audit found and fixed these additional local issues:

- Tracker violet actions had dark text with about 2.8:1 contrast. Solid violet,
  red and dark actions now retain white text. Emerald actions use a darker green
  so their white labels meet 4.5:1 small-text contrast.
- Slate helper labels in dashboard Performance/Activity, Messages and the payslip
  dialog were too faint (about 2.63-4.49:1). Admin-only label overrides cover
  regular and important utility classes, without changing employee themes.
- An expanded desktop sidebar consumed most of a phone screen and squeezed the
  header. Below 768px, navigation is a full-size overlay drawer. Hidden navigation
  is inert; open navigation traps keyboard focus, closes with Escape/backdrop/a
  destination, and restores focus. Desktop collapse preferences are preserved.
- Phone notification menus stay within viewport margins. Page titles and header
  actions no longer overlap at 320, 390, 768, 1024 and 1280px checked widths.
- Tracker's six fixed-width filters could overflow at desktop sizes with the
  sidebar open. Auto-fit grid columns now wrap by available content width.
- Employee Payroll had no minimum table width and column percentages totaled
  108%, causing overlapping values and actions on phones. Columns now total 100%
  in a 64rem minimum-width, keyboard-focusable horizontal scroll region. At the
  checked 15px root font, the table measured 960px and actions 192px; no seeded
  row cell overflowed. The whole document remained 390px wide on a 390px phone.

All 15 sidebar pages were visited at desktop and 390x844 phone sizes, with both
synthetic businesses checked. Nested checks covered dashboard views, all payroll
sections, HR sections, announcements, every Settings section, employee editing,
and team/task/job/lead/credential/product/payroll dialogs. Saving a dark employee
theme, refreshing, switching businesses, and signing out/in retained
`light-command` and native `color-scheme: light` for the admin. Drawer Tab wrapping,
Escape, focus restoration and reachable payroll actions were verified in-browser.

Measured solid-color text checks included modern CSS OKLCH colors and found no
remaining failures in the checked states. Gradients were excluded from that
solid-color calculation and checked visually/existing token tests. Disabled
controls, every possible populated dialog state, arbitrary future content, and
every physical browser version are not certified by this audit.

Commands and results for the follow-up:

- Root `npm run lint`: passed.
- Backend `npm run typecheck`: passed.
- Root `npm run build -- --outDir dist-local-employee-review` with local review
  flags: passed; the existing rich-text-editor bundle-size warning remains.
- Backend `node --import tsx --test --test-reporter=spec "src/**/*.test.ts"` with
  `CRM_INTEGRATION_MONGO_URI` pointing only to isolated loopback test Mongo:
  269 passed, zero failed/skipped.
- Focused `node --import tsx --test --test-reporter=spec src/services/adminTheme.test.ts`:
  10 passed. Includes contrast-token and layout-source regression guards; browser
  observations above complement those guards rather than being automated UI tests.

To recheck manually, sign into localhost:5173 as a local admin, visit every tab,
switch businesses, refresh and sign out/in. On a phone-width window, open/close
navigation with the menu and Escape, then horizontally scroll Employee Payroll
to its actions and open/close the minutes dialog without saving. Desktop sidebar
size, payroll calculations, attendance writes and production configuration were
not changed by this follow-up. GitHub contains source only; there was no online
deployment, database migration or production data change.
