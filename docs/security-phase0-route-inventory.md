# Security Phase 0: Route Declaration Inventory

Generated from TypeScript syntax in app.ts and each mounted router. No application/database state changed.

This table classifies explicit mount/route middleware only. Controller-level signature, owner, integration and feature-flag checks are documented separately in security-phase0-audit.md; a middleware-only label must not be mistaken for a complete authorization assessment.

| Router | Mount | app.ts Line | Routes |
| --- | --- | --- | --- |
| tomTomQuotaRouter | `/api/tomtom-quota` | 186 | 2 |
| publicSurveyRouter | `/api/public/surveys` | 187 | 1 |
| authRouter | `/api/auth` | 191 | 4 |
| employeeRouter | `/api/employees` | 193 | 8 |
| roleRouter | `/api/roles` | 194 | 4 |
| branchRouter | `/api/branches` | 195 | 4 |
| toolRouter | `/api/tools` | 196 | 4 |
| productCategoryRouter | `/api/product-categories` | 197 | 4 |
| mediaRouter | `/api/media` | 198 | 4 |
| featureFlagRouter | `/api/features` | 199 | 2 |
| systemSettingsRouter | `/api/system-settings` | 200 | 2 |
| taskRouter | `/api/tasks` | 201 | 7 |
| hrRouter | `/api/hr` | 202 | 13 |
| teamRouter | `/api/teams` | 203 | 4 |
| integrationRouter | `/api/integrations` | 204 | 1 |
| adminLeadRouter | `/api/admin-leads` | 205 | 3 |
| myLeadRouter | `/api/my-leads` | 206 | 3 |
| leadRouter | `/api/leads` | 207 | 39 |
| knowledgeBaseRouter | `/api/knowledge-base` | 208 | 12 |
| credentialRouter | `/api/credentials` | 209 | 4 |
| payrollRouter | `/api/payroll` | 210 | 17 |
| employeeEvaluationRouter | `/api/evaluations` | 211 | 3 |
| reportRouter | `/api/reports` | 212 | 1 |
| messageRouter | `/api/messages` | 213 | 12 |
| browserActivityRouter | `/api/browser-activity` | 214 | 9 |
| callBridgeRouter | `/api/call-bridge` | 215 | 11 |
| callDashboardRouter | `/api/call-dashboard` | 216 | 1 |
| dashboardWorkspaceRouter | `/api/dashboard-workspace` | 217 | 6 |
| noticeRouter | `/api` | 218 | 9 |
| leaveRequestRouter | `/api` | 219 | 8 |
| attendanceRouter | `/api` | 220 | 25 |
| employeeTransactionRouter | `/api` | 221 | 2 |
| callRouter | `/api/log` | 222 | 8 |

## Every Declared Route

| Method | URL | Explicit Guard Category | Additional Route Middleware | Handler | Reference |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/tomtom-quota/usage` | none | `none` | `readSharedTomTomUsage` | `backend/src/routes/tomTomQuotaRoutes.ts:6` |
| POST | `/api/tomtom-quota/reserve` | none | `none` | `reserveSharedTomTomRequest` | `backend/src/routes/tomTomQuotaRoutes.ts:7` |
| POST | `/api/public/surveys/help-save-the-hemp-industry` | none | `none` | `submitHempIndustrySurvey` | `backend/src/routes/publicSurveyRoutes.ts:6` |
| POST | `/api/auth/login` | none | `none` | `loginWithEmployeeCode` | `backend/src/routes/authRoutes.ts:6` |
| GET | `/api/auth/businesses` | none | `none` | `listEmployeeBusinesses` | `backend/src/routes/authRoutes.ts:7` |
| POST | `/api/auth/switch-business` | none | `none` | `switchEmployeeBusiness` | `backend/src/routes/authRoutes.ts:8` |
| POST | `/api/auth/logout` | none | `none` | `logoutEmployee` | `backend/src/routes/authRoutes.ts:9` |
| GET | `/api/employees` | businessAccessMiddleware only | `none` | `listEmployees` | `backend/src/routes/employeeRoutes.ts:15` |
| GET | `/api/employees/:id` | businessAccessMiddleware only | `none` | `getEmployee` | `backend/src/routes/employeeRoutes.ts:16` |
| POST | `/api/employees` | businessAccessMiddleware only | `none` | `createEmployee` | `backend/src/routes/employeeRoutes.ts:17` |
| PATCH | `/api/employees/:id/profile` | businessAccessMiddleware only | `none` | `updateEmployeeProfile` | `backend/src/routes/employeeRoutes.ts:18` |
| PATCH | `/api/employees/:id/bank` | businessAccessMiddleware only | `none` | `updateEmployeeBankDetails` | `backend/src/routes/employeeRoutes.ts:19` |
| PUT | `/api/employees/:id` | businessAccessMiddleware only | `none` | `updateEmployee` | `backend/src/routes/employeeRoutes.ts:20` |
| PATCH | `/api/employees/:id/archive` | businessAccessMiddleware only | `none` | `archiveEmployee` | `backend/src/routes/employeeRoutes.ts:21` |
| DELETE | `/api/employees/:id` | businessAccessMiddleware only | `none` | `deleteEmployee` | `backend/src/routes/employeeRoutes.ts:22` |
| GET | `/api/roles` | businessAccessMiddleware only | `none` | `listRoles` | `backend/src/routes/roleRoutes.ts:6` |
| POST | `/api/roles` | businessAccessMiddleware only | `none` | `createRole` | `backend/src/routes/roleRoutes.ts:7` |
| PUT | `/api/roles/:id` | businessAccessMiddleware only | `none` | `updateRole` | `backend/src/routes/roleRoutes.ts:8` |
| PATCH | `/api/roles/:id/archive` | businessAccessMiddleware only | `none` | `archiveRole` | `backend/src/routes/roleRoutes.ts:9` |
| GET | `/api/branches` | businessAccessMiddleware only | `none` | `listBranches` | `backend/src/routes/branchRoutes.ts:6` |
| POST | `/api/branches` | businessAccessMiddleware only | `none` | `createBranch` | `backend/src/routes/branchRoutes.ts:7` |
| PUT | `/api/branches/:id` | businessAccessMiddleware only | `none` | `updateBranch` | `backend/src/routes/branchRoutes.ts:8` |
| PATCH | `/api/branches/:id/archive` | businessAccessMiddleware only | `none` | `archiveBranch` | `backend/src/routes/branchRoutes.ts:9` |
| GET | `/api/tools` | businessAccessMiddleware only | `none` | `listTools` | `backend/src/routes/toolRoutes.ts:6` |
| POST | `/api/tools` | businessAccessMiddleware only | `none` | `createTool` | `backend/src/routes/toolRoutes.ts:7` |
| PUT | `/api/tools/:id` | businessAccessMiddleware only | `none` | `updateTool` | `backend/src/routes/toolRoutes.ts:8` |
| PATCH | `/api/tools/:id/archive` | businessAccessMiddleware only | `none` | `archiveTool` | `backend/src/routes/toolRoutes.ts:9` |
| GET | `/api/product-categories` | businessAccessMiddleware only | `none` | `listProductCategories` | `backend/src/routes/productCategoryRoutes.ts:11` |
| POST | `/api/product-categories` | businessAccessMiddleware only | `none` | `createProductCategory` | `backend/src/routes/productCategoryRoutes.ts:12` |
| PUT | `/api/product-categories/:id` | businessAccessMiddleware only | `none` | `updateProductCategory` | `backend/src/routes/productCategoryRoutes.ts:13` |
| PATCH | `/api/product-categories/:id/archive` | businessAccessMiddleware only | `none` | `archiveProductCategory` | `backend/src/routes/productCategoryRoutes.ts:14` |
| GET | `/api/media` | businessAccessMiddleware only | `none` | `listMediaAssets` | `backend/src/routes/mediaRoutes.ts:7` |
| POST | `/api/media` | verifiedAdminOnly | `verifiedAdminOnly` | `uploadMediaAsset` | `backend/src/routes/mediaRoutes.ts:8` |
| GET | `/api/media/file/:fileName` | businessAccessMiddleware only | `none` | `serveMediaAssetFile` | `backend/src/routes/mediaRoutes.ts:9` |
| PATCH | `/api/media/:id/archive` | verifiedAdminOnly | `verifiedAdminOnly` | `archiveMediaAsset` | `backend/src/routes/mediaRoutes.ts:10` |
| GET | `/api/features` | businessAccessMiddleware only | `none` | `listFeatureFlags` | `backend/src/routes/featureFlagRoutes.ts:6` |
| PUT | `/api/features/:key` | businessAccessMiddleware only | `none` | `updateFeatureFlag` | `backend/src/routes/featureFlagRoutes.ts:7` |
| GET | `/api/system-settings` | businessAccessMiddleware only | `none` | `readSystemSettings` | `backend/src/routes/systemSettingsRoutes.ts:7` |
| PUT | `/api/system-settings` | verifiedAdminOnly | `inline signed-admin check` | `updateSystemSettings` | `backend/src/routes/systemSettingsRoutes.ts:8` |
| GET | `/api/tasks` | businessAccessMiddleware only | `none` | `listTasks` | `backend/src/routes/taskRoutes.ts:6` |
| GET | `/api/tasks/:id` | businessAccessMiddleware only | `none` | `getTask` | `backend/src/routes/taskRoutes.ts:7` |
| POST | `/api/tasks` | businessAccessMiddleware only | `none` | `createTask` | `backend/src/routes/taskRoutes.ts:8` |
| PUT | `/api/tasks/:id` | businessAccessMiddleware only | `none` | `updateTask` | `backend/src/routes/taskRoutes.ts:9` |
| PATCH | `/api/tasks/:id/status` | businessAccessMiddleware only | `none` | `updateTaskStatus` | `backend/src/routes/taskRoutes.ts:10` |
| POST | `/api/tasks/:id/comments` | businessAccessMiddleware only | `none` | `addTaskComment` | `backend/src/routes/taskRoutes.ts:11` |
| PATCH | `/api/tasks/:id/archive` | businessAccessMiddleware only | `none` | `archiveTask` | `backend/src/routes/taskRoutes.ts:12` |
| GET | `/api/hr/jobs` | businessAccessMiddleware only | `none` | `listJobPostings` | `backend/src/routes/hrRoutes.ts:19` |
| POST | `/api/hr/jobs` | businessAccessMiddleware only | `none` | `createJobPosting` | `backend/src/routes/hrRoutes.ts:20` |
| PUT | `/api/hr/jobs/:id` | businessAccessMiddleware only | `none` | `updateJobPosting` | `backend/src/routes/hrRoutes.ts:21` |
| PATCH | `/api/hr/jobs/:id/archive` | businessAccessMiddleware only | `none` | `archiveJobPosting` | `backend/src/routes/hrRoutes.ts:22` |
| DELETE | `/api/hr/jobs/:id/permanent` | businessAccessMiddleware only | `none` | `permanentlyDeleteJobPosting` | `backend/src/routes/hrRoutes.ts:23` |
| GET | `/api/hr/applicants` | businessAccessMiddleware only | `none` | `listApplicants` | `backend/src/routes/hrRoutes.ts:24` |
| POST | `/api/hr/applicants` | businessAccessMiddleware only | `none` | `createApplicant` | `backend/src/routes/hrRoutes.ts:25` |
| PUT | `/api/hr/applicants/:id` | businessAccessMiddleware only | `none` | `updateApplicant` | `backend/src/routes/hrRoutes.ts:26` |
| PATCH | `/api/hr/applicants/:id/stage` | businessAccessMiddleware only | `none` | `updateApplicantStage` | `backend/src/routes/hrRoutes.ts:27` |
| POST | `/api/hr/applicants/:id/notes` | businessAccessMiddleware only | `none` | `addApplicantNote` | `backend/src/routes/hrRoutes.ts:28` |
| PATCH | `/api/hr/applicants/:id/archive` | businessAccessMiddleware only | `none` | `archiveApplicant` | `backend/src/routes/hrRoutes.ts:29` |
| DELETE | `/api/hr/applicants/:id/permanent` | businessAccessMiddleware only | `none` | `permanentlyDeleteApplicant` | `backend/src/routes/hrRoutes.ts:30` |
| DELETE | `/api/hr/applicants/:id` | businessAccessMiddleware only | `none` | `archiveApplicant` | `backend/src/routes/hrRoutes.ts:31` |
| GET | `/api/teams` | businessAccessMiddleware only | `none` | `listTeams` | `backend/src/routes/teamRoutes.ts:6` |
| POST | `/api/teams` | businessAccessMiddleware only | `none` | `createTeam` | `backend/src/routes/teamRoutes.ts:7` |
| PUT | `/api/teams/:id` | businessAccessMiddleware only | `none` | `updateTeam` | `backend/src/routes/teamRoutes.ts:8` |
| PATCH | `/api/teams/:id/archive` | businessAccessMiddleware only | `none` | `archiveTeam` | `backend/src/routes/teamRoutes.ts:9` |
| POST | `/api/integrations/customer-registration-leads` | businessAccessMiddleware only | `none` | `createCustomerRegistrationLead` | `backend/src/routes/integrationRoutes.ts:6` |
| GET | `/api/admin-leads/counts` | businessAccessMiddleware only | `none` | `countAdminLeads` | `backend/src/routes/adminLeadRoutes.ts:6` |
| GET | `/api/admin-leads` | businessAccessMiddleware only | `none` | `listAdminLeads` | `backend/src/routes/adminLeadRoutes.ts:7` |
| GET | `/api/admin-leads/:tab` | businessAccessMiddleware only | `none` | `listAdminLeads` | `backend/src/routes/adminLeadRoutes.ts:8` |
| GET | `/api/my-leads/counts` | businessAccessMiddleware only | `none` | `countMyLeads` | `backend/src/routes/myLeadRoutes.ts:6` |
| GET | `/api/my-leads` | businessAccessMiddleware only | `none` | `listMyLeads` | `backend/src/routes/myLeadRoutes.ts:7` |
| GET | `/api/my-leads/:tab` | businessAccessMiddleware only | `none` | `listMyLeads` | `backend/src/routes/myLeadRoutes.ts:8` |
| GET | `/api/leads` | businessAccessMiddleware only | `none` | `listLeads` | `backend/src/routes/leadRoutes.ts:41` |
| GET | `/api/leads/call-stats/me` | businessAccessMiddleware only | `none` | `getMyLeadCallStats` | `backend/src/routes/leadRoutes.ts:42` |
| GET | `/api/leads/call-stats` | businessAccessMiddleware only | `none` | `getLeadCallStats` | `backend/src/routes/leadRoutes.ts:43` |
| GET | `/api/leads/counts` | businessAccessMiddleware only | `none` | `countLeads` | `backend/src/routes/leadRoutes.ts:44` |
| GET | `/api/leads/my` | businessAccessMiddleware only | `none` | `listMyLeads` | `backend/src/routes/leadRoutes.ts:45` |
| GET | `/api/leads/agent-dashboard` | businessAccessMiddleware only | `none` | `readAgentLeadDashboard` | `backend/src/routes/leadRoutes.ts:46` |
| GET | `/api/leads/employee-logs` | businessAccessMiddleware only | `none` | `listEmployeeLeadLogs` | `backend/src/routes/leadRoutes.ts:47` |
| GET | `/api/leads/:id` | businessAccessMiddleware only | `none` | `readLead` | `backend/src/routes/leadRoutes.ts:48` |
| POST | `/api/leads` | businessAccessMiddleware only | `none` | `createLead` | `backend/src/routes/leadRoutes.ts:49` |
| POST | `/api/leads/ai-score` | businessAccessMiddleware only | `none` | `scoreLeadsByHighestPotential` | `backend/src/routes/leadRoutes.ts:50` |
| POST | `/api/leads/import` | businessAccessMiddleware only | `none` | `importLeads` | `backend/src/routes/leadRoutes.ts:51` |
| PATCH | `/api/leads/reassign-new` | businessAccessMiddleware only | `none` | `reassignNewLeadsBatch` | `backend/src/routes/leadRoutes.ts:52` |
| PATCH | `/api/leads/bulk/archive` | businessAccessMiddleware only | `none` | `bulkArchiveLeads` | `backend/src/routes/leadRoutes.ts:53` |
| PATCH | `/api/leads/bulk/archive-all` | businessAccessMiddleware only | `none` | `archiveAllActiveLeads` | `backend/src/routes/leadRoutes.ts:54` |
| PATCH | `/api/leads/bulk/restore` | businessAccessMiddleware only | `none` | `bulkRestoreLeads` | `backend/src/routes/leadRoutes.ts:55` |
| PATCH | `/api/leads/bulk/assign` | businessAccessMiddleware only | `none` | `bulkAssignLeads` | `backend/src/routes/leadRoutes.ts:56` |
| DELETE | `/api/leads/bulk/permanent` | businessAccessMiddleware only | `none` | `bulkPermanentlyDeleteArchivedLeads` | `backend/src/routes/leadRoutes.ts:57` |
| DELETE | `/api/leads/bulk/active/permanent` | businessAccessMiddleware only | `none` | `bulkPermanentlyDeleteActiveLeads` | `backend/src/routes/leadRoutes.ts:58` |
| PATCH | `/api/leads/archived/restore` | businessAccessMiddleware only | `none` | `restoreAllArchivedLeads` | `backend/src/routes/leadRoutes.ts:59` |
| DELETE | `/api/leads/archived/permanent` | businessAccessMiddleware only | `none` | `permanentlyDeleteArchivedLeads` | `backend/src/routes/leadRoutes.ts:60` |
| PUT | `/api/leads/:id` | businessAccessMiddleware only | `none` | `updateLead` | `backend/src/routes/leadRoutes.ts:61` |
| PATCH | `/api/leads/:id/assign` | businessAccessMiddleware only | `none` | `assignLead` | `backend/src/routes/leadRoutes.ts:62` |
| PATCH | `/api/leads/:id/archive` | businessAccessMiddleware only | `none` | `archiveLead` | `backend/src/routes/leadRoutes.ts:63` |
| PATCH | `/api/leads/:id/restore` | businessAccessMiddleware only | `none` | `restoreLead` | `backend/src/routes/leadRoutes.ts:64` |
| DELETE | `/api/leads/:id/permanent` | businessAccessMiddleware only | `none` | `permanentlyDeleteLead` | `backend/src/routes/leadRoutes.ts:65` |
| POST | `/api/leads/:id/comments` | businessAccessMiddleware only | `none` | `addLeadComment` | `backend/src/routes/leadRoutes.ts:66` |
| POST | `/api/leads/:id/calls` | businessAccessMiddleware only | `none` | `recordLeadCall` | `backend/src/routes/leadRoutes.ts:67` |
| PATCH | `/api/leads/:id/comments/:commentId` | businessAccessMiddleware only | `none` | `updateLeadComment` | `backend/src/routes/leadRoutes.ts:68` |
| PATCH | `/api/leads/:id/status` | businessAccessMiddleware only | `none` | `updateLeadStatus` | `backend/src/routes/leadRoutes.ts:69` |
| PATCH | `/api/leads/:id/favorite` | businessAccessMiddleware only | `none` | `toggleLeadFavorite` | `backend/src/routes/leadRoutes.ts:70` |
| PATCH | `/api/leads/:id/follow-up` | businessAccessMiddleware only | `none` | `scheduleLeadFollowUp` | `backend/src/routes/leadRoutes.ts:71` |
| PATCH | `/api/leads/:id/auto-assign` | businessAccessMiddleware only | `none` | `autoAssignLead` | `backend/src/routes/leadRoutes.ts:72` |
| GET | `/api/leads/tomtom/usage` | businessAccessMiddleware only | `none` | `readTomTomPlacesUsage` | `backend/src/routes/leadRoutes.ts:73` |
| POST | `/api/leads/tomtom/search-import` | businessAccessMiddleware only | `none` | `searchAndImportTomTomPlacesAsLeads` | `backend/src/routes/leadRoutes.ts:74` |
| POST | `/api/leads/tomtom/auto-search` | businessAccessMiddleware only | `none` | `autoSearchTomTomPlacesForProduct` | `backend/src/routes/leadRoutes.ts:75` |
| GET | `/api/leads/:id/call-stat` | businessAccessMiddleware only | `none` | `getLeadCallStat` | `backend/src/routes/leadRoutes.ts:78` |
| PATCH | `/api/leads/:id/log-call` | businessAccessMiddleware only | `none` | `logConnectedCall` | `backend/src/routes/leadRoutes.ts:80` |
| PATCH | `/api/leads/:id/not-connected` | businessAccessMiddleware only | `none` | `logNotConnectedCall` | `backend/src/routes/leadRoutes.ts:81` |
| PATCH | `/api/leads/:id/voicemail` | businessAccessMiddleware only | `none` | `logVoicemailCall` | `backend/src/routes/leadRoutes.ts:82` |
| GET | `/api/knowledge-base` | businessAccessMiddleware only | `none` | `listKnowledgeBaseEntries` | `backend/src/routes/knowledgeBaseRoutes.ts:20` |
| GET | `/api/knowledge-base/suggestions` | businessAccessMiddleware only | `none` | `listKnowledgeBaseSuggestions` | `backend/src/routes/knowledgeBaseRoutes.ts:21` |
| GET | `/api/knowledge-base/photos/file/:fileName` | businessAccessMiddleware only | `none` | `serveKnowledgeBasePhotoFile` | `backend/src/routes/knowledgeBaseRoutes.ts:22` |
| GET | `/api/knowledge-base/documents/file/:fileName` | businessAccessMiddleware only | `none` | `serveKnowledgeBaseDocumentFile` | `backend/src/routes/knowledgeBaseRoutes.ts:23` |
| POST | `/api/knowledge-base` | businessAccessMiddleware only | `none` | `createKnowledgeBaseEntry` | `backend/src/routes/knowledgeBaseRoutes.ts:24` |
| POST | `/api/knowledge-base/documents` | businessAccessMiddleware only | `none` | `uploadKnowledgeBaseDocument` | `backend/src/routes/knowledgeBaseRoutes.ts:25` |
| POST | `/api/knowledge-base/photos` | businessAccessMiddleware only | `raw(...)` | `uploadKnowledgeBasePhoto` | `backend/src/routes/knowledgeBaseRoutes.ts:26` |
| POST | `/api/knowledge-base/suggestions` | businessAccessMiddleware only | `none` | `createKnowledgeBaseSuggestion` | `backend/src/routes/knowledgeBaseRoutes.ts:31` |
| PATCH | `/api/knowledge-base/suggestions/:id/approve` | businessAccessMiddleware only | `none` | `approveKnowledgeBaseSuggestion` | `backend/src/routes/knowledgeBaseRoutes.ts:32` |
| PATCH | `/api/knowledge-base/suggestions/:id/reject` | businessAccessMiddleware only | `none` | `rejectKnowledgeBaseSuggestion` | `backend/src/routes/knowledgeBaseRoutes.ts:33` |
| PUT | `/api/knowledge-base/:id` | businessAccessMiddleware only | `none` | `updateKnowledgeBaseEntry` | `backend/src/routes/knowledgeBaseRoutes.ts:34` |
| PATCH | `/api/knowledge-base/:id/archive` | businessAccessMiddleware only | `none` | `archiveKnowledgeBaseEntry` | `backend/src/routes/knowledgeBaseRoutes.ts:35` |
| GET | `/api/credentials` | businessAccessMiddleware only | `none` | `listCredentials` | `backend/src/routes/credentialRoutes.ts:6` |
| POST | `/api/credentials` | businessAccessMiddleware only | `none` | `createCredential` | `backend/src/routes/credentialRoutes.ts:7` |
| PUT | `/api/credentials/:id` | businessAccessMiddleware only | `none` | `updateCredential` | `backend/src/routes/credentialRoutes.ts:8` |
| PATCH | `/api/credentials/:id/archive` | businessAccessMiddleware only | `none` | `archiveCredential` | `backend/src/routes/credentialRoutes.ts:9` |
| GET | `/api/payroll/stats` | verifiedAdminOnly | `verifiedAdminOnly` | `listPayrollStats` | `backend/src/routes/payrollRoutes.ts:26` |
| GET | `/api/payroll/dtr/:employeeId` | verifiedAdminOnly | `verifiedAdminOnly` | `getPayrollDtr` | `backend/src/routes/payrollRoutes.ts:27` |
| GET | `/api/payroll/records` | verifiedAdminOnly | `verifiedAdminOnly` | `listPayrollRecords` | `backend/src/routes/payrollRoutes.ts:28` |
| POST | `/api/payroll/records` | verifiedAdminOnly | `verifiedAdminOnly` | `createPayrollRecord` | `backend/src/routes/payrollRoutes.ts:29` |
| PUT | `/api/payroll/records/:id` | verifiedAdminOnly | `verifiedAdminOnly` | `updatePayrollRecord` | `backend/src/routes/payrollRoutes.ts:30` |
| PATCH | `/api/payroll/records/:id/overtime` | verifiedAdminOnly | `verifiedAdminOnly` | `updatePayrollOvertime` | `backend/src/routes/payrollRoutes.ts:31` |
| PATCH | `/api/payroll/records/:id/worked-minutes` | verifiedAdminOnly | `verifiedAdminOnly` | `updatePayrollWorkedMinutes` | `backend/src/routes/payrollRoutes.ts:32` |
| PATCH | `/api/payroll/employees/:employeeId/basic-pay` | verifiedAdminOnly | `verifiedAdminOnly` | `updateEmployeeBasicPay` | `backend/src/routes/payrollRoutes.ts:33` |
| PATCH | `/api/payroll/records/:id/paid` | verifiedAdminOnly | `verifiedAdminOnly` | `markPayrollRecordPaid` | `backend/src/routes/payrollRoutes.ts:34` |
| PATCH | `/api/payroll/records/:id/unpaid` | verifiedAdminOnly | `verifiedAdminOnly` | `markPayrollRecordUnpaid` | `backend/src/routes/payrollRoutes.ts:35` |
| PATCH | `/api/payroll/records/:id/archive` | verifiedAdminOnly | `verifiedAdminOnly` | `archivePayrollRecord` | `backend/src/routes/payrollRoutes.ts:36` |
| PATCH | `/api/payroll/records/:id/restore` | verifiedAdminOnly | `verifiedAdminOnly` | `restorePayrollRecord` | `backend/src/routes/payrollRoutes.ts:37` |
| POST | `/api/payroll/run` | verifiedAdminOnly | `verifiedAdminOnly` | `runPayroll` | `backend/src/routes/payrollRoutes.ts:38` |
| GET | `/api/payroll/items` | verifiedAdminOnly | `verifiedAdminOnly` | `listPayrollItems` | `backend/src/routes/payrollRoutes.ts:39` |
| POST | `/api/payroll/items` | verifiedAdminOnly | `verifiedAdminOnly` | `createPayrollItem` | `backend/src/routes/payrollRoutes.ts:40` |
| PATCH | `/api/payroll/items/:id/archive` | verifiedAdminOnly | `verifiedAdminOnly` | `archivePayrollItem` | `backend/src/routes/payrollRoutes.ts:41` |
| PATCH | `/api/payroll/items/:id/restore` | verifiedAdminOnly | `verifiedAdminOnly` | `restorePayrollItem` | `backend/src/routes/payrollRoutes.ts:42` |
| GET | `/api/evaluations` | businessAccessMiddleware only | `none` | `listEmployeeEvaluations` | `backend/src/routes/employeeEvaluationRoutes.ts:6` |
| POST | `/api/evaluations` | businessAccessMiddleware only | `none` | `saveEmployeeEvaluation` | `backend/src/routes/employeeEvaluationRoutes.ts:7` |
| PATCH | `/api/evaluations/:evaluationId` | businessAccessMiddleware only | `none` | `updateEmployeeEvaluation` | `backend/src/routes/employeeEvaluationRoutes.ts:8` |
| GET | `/api/reports/agent-productivity` | businessAccessMiddleware only | `none` | `readAgentProductivityReport` | `backend/src/routes/reportRoutes.ts:6` |
| GET | `/api/messages/conversations` | businessAccessMiddleware only | `none` | `listConversations` | `backend/src/routes/messageRoutes.ts:19` |
| GET | `/api/messages/notifications/unread` | businessAccessMiddleware only | `none` | `listUnreadMessageNotifications` | `backend/src/routes/messageRoutes.ts:20` |
| POST | `/api/messages/notifications/:messageId/seen` | businessAccessMiddleware only | `none` | `markMessageNotificationSeen` | `backend/src/routes/messageRoutes.ts:21` |
| POST | `/api/messages/conversations/direct` | businessAccessMiddleware only | `none` | `createDirectConversation` | `backend/src/routes/messageRoutes.ts:22` |
| POST | `/api/messages/conversations/team` | businessAccessMiddleware only | `none` | `createTeamConversation` | `backend/src/routes/messageRoutes.ts:23` |
| GET | `/api/messages/conversations/:conversationId/messages` | businessAccessMiddleware only | `none` | `listMessages` | `backend/src/routes/messageRoutes.ts:24` |
| POST | `/api/messages/conversations/:conversationId/messages` | businessAccessMiddleware only | `none` | `createMessage` | `backend/src/routes/messageRoutes.ts:25` |
| POST | `/api/messages/conversations/:conversationId/seen` | businessAccessMiddleware only | `none` | `markMessagesSeen` | `backend/src/routes/messageRoutes.ts:26` |
| PATCH | `/api/messages/conversations/:conversationId/messages/:messageId` | businessAccessMiddleware only | `none` | `updateMessage` | `backend/src/routes/messageRoutes.ts:27` |
| DELETE | `/api/messages/conversations/:conversationId/messages/:messageId` | businessAccessMiddleware only | `none` | `deleteMessage` | `backend/src/routes/messageRoutes.ts:28` |
| POST | `/api/messages/conversations/:conversationId/attachments` | businessAccessMiddleware only | `none` | `uploadMessageAttachment` | `backend/src/routes/messageRoutes.ts:29` |
| GET | `/api/messages/attachments/:fileName` | businessAccessMiddleware only | `none` | `serveMessageAttachment` | `backend/src/routes/messageRoutes.ts:30` |
| POST | `/api/browser-activity/events/bulk` | businessAccessMiddleware only | `none` | `createBrowserActivityEvents` | `backend/src/routes/browserActivityRoutes.ts:16` |
| POST | `/api/browser-activity/screenshots` | businessAccessMiddleware only | `none` | `createBrowserActivityScreenshot` | `backend/src/routes/browserActivityRoutes.ts:17` |
| GET | `/api/browser-activity/tracking-status` | businessAccessMiddleware only | `none` | `getBrowserActivityTrackingStatus` | `backend/src/routes/browserActivityRoutes.ts:18` |
| GET | `/api/browser-activity/events` | businessAccessMiddleware only | `none` | `listBrowserActivityEvents` | `backend/src/routes/browserActivityRoutes.ts:19` |
| GET | `/api/browser-activity/screenshots/file/:dateKey/:fileName` | businessAccessMiddleware only | `none` | `serveBrowserActivityScreenshotFile` | `backend/src/routes/browserActivityRoutes.ts:20` |
| GET | `/api/browser-activity/screenshots` | businessAccessMiddleware only | `none` | `listBrowserActivityScreenshots` | `backend/src/routes/browserActivityRoutes.ts:21` |
| GET | `/api/browser-activity/extension-package` | businessAccessMiddleware only | `none` | `downloadBrowserActivityExtension` | `backend/src/routes/browserActivityRoutes.ts:22` |
| GET | `/api/browser-activity/live-view-agent-package` | businessAccessMiddleware only | `none` | `downloadLiveViewAgent` | `backend/src/routes/browserActivityRoutes.ts:23` |
| DELETE | `/api/browser-activity` | businessAccessMiddleware only | `none` | `clearBrowserActivityData` | `backend/src/routes/browserActivityRoutes.ts:24` |
| POST | `/api/call-bridge/pairings` | businessAccessMiddleware only | `none` | `createCallBridgePairing` | `backend/src/routes/callBridgeRoutes.ts:62` |
| POST | `/api/call-bridge/claim` | businessAccessMiddleware only | `none` | `claimCallBridgePairing` | `backend/src/routes/callBridgeRoutes.ts:63` |
| POST | `/api/call-bridge/activate` | businessAccessMiddleware only | `none` | `activateCallBridgeForEmployee` | `backend/src/routes/callBridgeRoutes.ts:64` |
| POST | `/api/call-bridge/heartbeat` | businessAccessMiddleware only | `none` | `updateCallBridgeHeartbeat` | `backend/src/routes/callBridgeRoutes.ts:65` |
| GET | `/api/call-bridge/status` | businessAccessMiddleware only | `none` | `getCallBridgeStatus` | `backend/src/routes/callBridgeRoutes.ts:66` |
| GET | `/api/call-bridge/attempts/latest` | businessAccessMiddleware only | `none` | `getLatestCallBridgeAttempt` | `backend/src/routes/callBridgeRoutes.ts:67` |
| POST | `/api/call-bridge/reserve` | businessAccessMiddleware only | `logReserveConflict` | `reserveCallBridgeCall` | `backend/src/routes/callBridgeRoutes.ts:68` |
| POST | `/api/call-bridge/dial-start` | businessAccessMiddleware only | `logDialStartFailure` | `markCallBridgeDialStarted` | `backend/src/routes/callBridgeRoutes.ts:69` |
| POST | `/api/call-bridge/release` | businessAccessMiddleware only | `none` | `releaseCallBridgeCall` | `backend/src/routes/callBridgeRoutes.ts:70` |
| DELETE | `/api/call-bridge/devices` | businessAccessMiddleware only | `none` | `revokeCallBridgeDevices` | `backend/src/routes/callBridgeRoutes.ts:71` |
| GET | `/api/call-bridge/package` | businessAccessMiddleware only | `none` | `downloadCallBridgePackage` | `backend/src/routes/callBridgeRoutes.ts:72` |
| GET | `/api/call-dashboard` | businessAccessMiddleware only | `none` | `getCallDashboard` | `backend/src/routes/callDashboardRoutes.ts:5` |
| GET | `/api/dashboard-workspace/summary` | businessAccessMiddleware only | `none` | `dashboardWorkspaceSummary` | `backend/src/routes/dashboardWorkspaceRoutes.ts:4` |
| GET | `/api/dashboard-workspace/employee/:code` | businessAccessMiddleware only | `none` | `dashboardEmployeeQuickView` | `backend/src/routes/dashboardWorkspaceRoutes.ts:5` |
| PUT | `/api/dashboard-workspace/settings` | businessAccessMiddleware only | `none` | `saveDashboardWorkspace` | `backend/src/routes/dashboardWorkspaceRoutes.ts:6` |
| POST | `/api/dashboard-workspace/notes` | businessAccessMiddleware only | `none` | `saveDashboardNote` | `backend/src/routes/dashboardWorkspaceRoutes.ts:7` |
| PATCH | `/api/dashboard-workspace/notes/:id` | businessAccessMiddleware only | `none` | `saveDashboardNote` | `backend/src/routes/dashboardWorkspaceRoutes.ts:8` |
| DELETE | `/api/dashboard-workspace/notes/:id` | businessAccessMiddleware only | `none` | `saveDashboardNote` | `backend/src/routes/dashboardWorkspaceRoutes.ts:9` |
| GET | `/api/notices` | businessAccessMiddleware only | `none` | `listRecentNotices` | `backend/src/routes/noticeRoutes.ts:16` |
| GET | `/api/employees/:employeeId/notices` | businessAccessMiddleware only | `none` | `listEmployeeNotices` | `backend/src/routes/noticeRoutes.ts:17` |
| POST | `/api/employees/:employeeId/notices` | businessAccessMiddleware only | `none` | `createEmployeeNotice` | `backend/src/routes/noticeRoutes.ts:18` |
| PATCH | `/api/employees/:employeeId/notices/read` | businessAccessMiddleware only | `none` | `markEmployeeNoticesRead` | `backend/src/routes/noticeRoutes.ts:19` |
| PATCH | `/api/employees/:employeeId/notices/:noticeId` | businessAccessMiddleware only | `none` | `updateEmployeeNotice` | `backend/src/routes/noticeRoutes.ts:20` |
| DELETE | `/api/employees/:employeeId/notices/:noticeId` | businessAccessMiddleware only | `none` | `deleteEmployeeNotice` | `backend/src/routes/noticeRoutes.ts:21` |
| PATCH | `/api/employees/:employeeId/notices/:noticeId/read` | businessAccessMiddleware only | `none` | `markEmployeeNoticeRead` | `backend/src/routes/noticeRoutes.ts:22` |
| PATCH | `/api/employees/:employeeId/notices/:noticeId/acknowledge` | businessAccessMiddleware only | `none` | `acknowledgeEmployeeNotice` | `backend/src/routes/noticeRoutes.ts:23` |
| POST | `/api/employees/:employeeId/notices/:noticeId/replies` | businessAccessMiddleware only | `none` | `replyToEmployeeNotice` | `backend/src/routes/noticeRoutes.ts:24` |
| GET | `/api/leave-requests` | businessAccessMiddleware only | `none` | `listLeaveRequests` | `backend/src/routes/leaveRequestRoutes.ts:15` |
| GET | `/api/employees/:employeeId/leave-requests` | businessAccessMiddleware only | `none` | `listEmployeeLeaveRequests` | `backend/src/routes/leaveRequestRoutes.ts:16` |
| POST | `/api/employees/:employeeId/leave-requests` | businessAccessMiddleware only | `none` | `createEmployeeLeaveRequest` | `backend/src/routes/leaveRequestRoutes.ts:17` |
| PATCH | `/api/employees/:employeeId/leave-requests/:requestId` | businessAccessMiddleware only | `none` | `updateEmployeeLeaveRequest` | `backend/src/routes/leaveRequestRoutes.ts:18` |
| PATCH | `/api/employees/:employeeId/leave-requests/:requestId/replies` | businessAccessMiddleware only | `none` | `replyToLeaveRequest` | `backend/src/routes/leaveRequestRoutes.ts:19` |
| PATCH | `/api/leave-requests/:requestId/comment` | businessAccessMiddleware only | `none` | `commentLeaveRequest` | `backend/src/routes/leaveRequestRoutes.ts:20` |
| PATCH | `/api/leave-requests/:requestId/approve` | businessAccessMiddleware only | `none` | `approveLeaveRequest` | `backend/src/routes/leaveRequestRoutes.ts:21` |
| PATCH | `/api/leave-requests/:requestId/reject` | businessAccessMiddleware only | `none` | `rejectLeaveRequest` | `backend/src/routes/leaveRequestRoutes.ts:22` |
| GET | `/api/employees/:employeeId/attendance/session` | businessAccessMiddleware only | `none` | `getActiveAttendanceSession` | `backend/src/routes/attendanceRoutes.ts:9` |
| GET | `/api/employees/:employeeId/attendance/migration-preview` | businessAccessMiddleware only | `none` | `getAttendanceMigrationPreview` | `backend/src/routes/attendanceRoutes.ts:10` |
| POST | `/api/employees/:employeeId/attendance/commands` | businessAccessMiddleware only | `none` | `submitAttendanceCommand` | `backend/src/routes/attendanceRoutes.ts:11` |
| POST | `/api/employees/:employeeId/attendance/preview` | businessAccessMiddleware only | `none` | `previewAttendanceCorrection` | `backend/src/routes/attendanceRoutes.ts:12` |
| GET | `/api/attendance-policy` | businessAccessMiddleware only | `none` | `getAttendancePolicy` | `backend/src/routes/attendanceRoutes.ts:13` |
| PUT | `/api/attendance-policy` | businessAccessMiddleware only | `none` | `saveAttendancePolicy` | `backend/src/routes/attendanceRoutes.ts:14` |
| GET | `/api/attendance-hub/summary` | businessAccessMiddleware only | `none` | `getHubSummary` | `backend/src/routes/attendanceRoutes.ts:16` |
| GET | `/api/attendance-hub/live` | businessAccessMiddleware only | `none` | `getHubLive` | `backend/src/routes/attendanceRoutes.ts:17` |
| GET | `/api/attendance-hub/days` | businessAccessMiddleware only | `none` | `listHubDays` | `backend/src/routes/attendanceRoutes.ts:18` |
| GET | `/api/attendance-hub/export` | businessAccessMiddleware only | `none` | `exportHubDays` | `backend/src/routes/attendanceRoutes.ts:19` |
| GET | `/api/attendance-hub/day/:dayKey` | businessAccessMiddleware only | `none` | `getHubDay` | `backend/src/routes/attendanceRoutes.ts:20` |
| POST | `/api/attendance-hub/day/:dayKey/note` | businessAccessMiddleware only | `none` | `saveHubDayNote` | `backend/src/routes/attendanceRoutes.ts:21` |
| GET | `/api/attendance` | businessAccessMiddleware only | `none` | `getScopedAttendanceList` | `backend/src/routes/attendanceRoutes.ts:23` |
| GET | `/api/employees/:employeeId/attendance` | businessAccessMiddleware only | `none` | `getAttendanceHistory` | `backend/src/routes/attendanceRoutes.ts:24` |
| POST | `/api/employees/:employeeId/attendance` | businessAccessMiddleware only | `requireCurrentAttendanceClient` | `withAttendanceActionLock(...)` | `backend/src/routes/attendanceRoutes.ts:25` |
| PUT | `/api/employees/:employeeId/attendance/:attendanceId` | businessAccessMiddleware only | `requireCurrentAttendanceClient` | `withAttendanceActionLock(...)` | `backend/src/routes/attendanceRoutes.ts:26` |
| PATCH | `/api/employees/:employeeId/attendance/worked-minutes` | businessAccessMiddleware only | `requireCurrentAttendanceClient` | `withAttendanceActionLock(...)` | `backend/src/routes/attendanceRoutes.ts:27` |
| PATCH | `/api/employees/:employeeId/attendance/:attendanceId/archive` | businessAccessMiddleware only | `requireCurrentAttendanceClient` | `withAttendanceActionLock(...)` | `backend/src/routes/attendanceRoutes.ts:28` |
| POST | `/api/employees/:employeeId/attendance/time-in` | businessAccessMiddleware only | `requireCurrentAttendanceClient` | `withAttendanceActionLock(...)` | `backend/src/routes/attendanceRoutes.ts:29` |
| POST | `/api/employees/:employeeId/attendance/time-out` | businessAccessMiddleware only | `requireCurrentAttendanceClient` | `withAttendanceActionLock(...)` | `backend/src/routes/attendanceRoutes.ts:30` |
| POST | `/api/employees/:employeeId/attendance/break-out` | businessAccessMiddleware only | `requireCurrentAttendanceClient` | `withAttendanceActionLock(...)` | `backend/src/routes/attendanceRoutes.ts:31` |
| POST | `/api/employees/:employeeId/attendance/break-in` | businessAccessMiddleware only | `requireCurrentAttendanceClient` | `withAttendanceActionLock(...)` | `backend/src/routes/attendanceRoutes.ts:32` |
| POST | `/api/employees/:employeeId/attendance/lunch-break-out` | businessAccessMiddleware only | `requireCurrentAttendanceClient` | `withAttendanceActionLock(...)` | `backend/src/routes/attendanceRoutes.ts:33` |
| POST | `/api/employees/:employeeId/attendance/lunch-break-in` | businessAccessMiddleware only | `requireCurrentAttendanceClient` | `withAttendanceActionLock(...)` | `backend/src/routes/attendanceRoutes.ts:34` |
| POST | `/api/employees/:employeeId/activity` | businessAccessMiddleware only | `requireCurrentAttendanceClient` | `withAttendanceActionLock(...)` | `backend/src/routes/attendanceRoutes.ts:35` |
| GET | `/api/employees/:employeeId/transactions` | businessAccessMiddleware only | `none` | `listEmployeeTransactions` | `backend/src/routes/employeeTransactionRoutes.ts:6` |
| GET | `/api/employees/:employeeId/recent-activity` | businessAccessMiddleware only | `none` | `listEmployeeRecentActivity` | `backend/src/routes/employeeTransactionRoutes.ts:7` |
| GET | `/api/log/call-stats/me` | businessAccessMiddleware only | `none` | `getMyLeadCallStats` | `backend/src/routes/callLoggerRoutes.ts:7` |
| GET | `/api/log/call-stats` | businessAccessMiddleware only | `none` | `getLeadCallStats` | `backend/src/routes/callLoggerRoutes.ts:8` |
| GET | `/api/log/call-summary/me` | businessAccessMiddleware only | `none` | `getMyLeadCallSummary` | `backend/src/routes/callLoggerRoutes.ts:9` |
| GET | `/api/log/call-summary` | businessAccessMiddleware only | `none` | `getLeadCallSummary` | `backend/src/routes/callLoggerRoutes.ts:10` |
| GET | `/api/log/:id/call-stat` | businessAccessMiddleware only | `none` | `getLeadCallStat` | `backend/src/routes/callLoggerRoutes.ts:11` |
| PATCH | `/api/log/:id/log-call` | businessAccessMiddleware only | `none` | `logConnectedCall` | `backend/src/routes/callLoggerRoutes.ts:12` |
| PATCH | `/api/log/:id/not-connected` | businessAccessMiddleware only | `none` | `logNotConnectedCall` | `backend/src/routes/callLoggerRoutes.ts:13` |
| PATCH | `/api/log/:id/voicemail` | businessAccessMiddleware only | `none` | `logVoicemailCall` | `backend/src/routes/callLoggerRoutes.ts:14` |

Standalone /api/health, /api/businesses and /uploads entries are covered in the main audit. Repeated middleware mounts (/api business context/access and error handler) are not endpoint routers.
