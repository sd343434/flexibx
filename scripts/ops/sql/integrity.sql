-- Post-restore integrity checks. One "check<TAB>violations" line each; every value must be
-- 0. Reads counts only — no customer content is printed.

-- Migrations not in a clean applied state: no attempt of the migration is applied
-- (finished and not rolled back), or an attempt failed and was never resolved (Prisma
-- refuses to deploy until it is). An attempt that was rolled back with
-- `prisma migrate resolve --rolled-back` and then re-applied is history, not a failure.
-- Whether every repository migration is present and unchanged is db-verify.sh's job.
SELECT 'migrations_unfinished', count(*) FROM (
  SELECT migration_name FROM _prisma_migrations GROUP BY migration_name
  HAVING NOT bool_or(finished_at IS NOT NULL AND rolled_back_at IS NULL)
      OR bool_or(finished_at IS NULL AND rolled_back_at IS NULL)
) unfinished;

-- Credit balances match the last ledger entry of each workspace (an account without any
-- entry must be all zero: it is created with a SUBSCRIPTION_GRANT entry when it has credits).
SELECT 'credit_balance_vs_ledger', count(*) FROM credit_accounts a
  LEFT JOIN LATERAL (
    SELECT subscription_after, purchased_after, held_after FROM credit_ledger_entries e
    WHERE e.workspace_id = a.workspace_id ORDER BY e.sequence DESC LIMIT 1
  ) last ON true
  WHERE COALESCE(last.subscription_after, 0) <> a.subscription_credits
     OR COALESCE(last.purchased_after, 0) <> a.purchased_credits
     OR COALESCE(last.held_after, 0) <> a.held_credits;

-- Held credits equal the open holds of each workspace.
SELECT 'credit_held_vs_open_holds', count(*) FROM credit_accounts a
  WHERE a.held_credits <> COALESCE(
    (SELECT sum(h.amount) FROM credit_holds h WHERE h.workspace_id = a.workspace_id AND h.status = 'HELD'), 0);

-- Append-only and same-workspace guards survived the restore (3 triggers, firing).
SELECT 'ledger_guard_triggers_missing', 3 - count(*) FROM pg_trigger
  WHERE tgrelid = 'credit_ledger_entries'::regclass AND NOT tgisinternal AND tgenabled IN ('O', 'A');

-- Every guard trigger the migrations create (append-only histories and ledgers, immutable
-- review decisions, same-workspace and workspace-immutable rows, the platform-admin grant
-- guard, state transitions, the Creator Studio's same-project, active-project and deletion
-- record guards) exists and fires. A trigger that is missing, DISABLEd or
-- ENABLE REPLICA (does not fire for the application's sessions) counts: pg_dump keeps
-- that state, so a backup taken while a guard was switched off restores without it.
-- The list must equal the migrated schema's triggers (tests/integration/ops-integrity-sql.test.ts).
SELECT 'guard_triggers_inactive', count(*) FROM (VALUES
  ('ad_accounts', 'ad_accounts_same_workspace'),
  ('ad_accounts', 'ad_accounts_workspace_immutable'),
  ('ad_connections', 'ad_connections_workspace_immutable'),
  ('ad_execution_steps', 'ad_execution_steps_same_workspace'),
  ('ad_execution_steps', 'ad_execution_steps_workspace_immutable'),
  ('ad_oauth_states', 'ad_oauth_states_workspace_immutable'),
  ('ad_plans', 'ad_plans_activation_same_workspace'),
  ('ad_plans', 'ad_plans_platform'),
  ('ad_plans', 'ad_plans_same_workspace'),
  ('ad_plans', 'ad_plans_workspace_immutable'),
  ('ad_spend_limits', 'ad_spend_limits_workspace_immutable'),
  ('agent_runs', 'agent_runs_workspace_immutable'),
  ('agent_task_approvals', 'agent_task_approvals_immutable'),
  ('agent_task_approvals', 'agent_task_approvals_insert'),
  ('agent_tasks', 'agent_tasks_grant'),
  ('agent_tasks', 'agent_tasks_same_workspace'),
  ('agent_tasks', 'agent_tasks_workspace_immutable'),
  ('ai_generations', 'ai_generations_same_workspace'),
  ('ai_generations', 'ai_generations_workspace_immutable'),
  ('audiences', 'audiences_workspace_immutable'),
  ('brands', 'brands_workspace_immutable'),
  ('campaign_plan_items', 'campaign_plan_items_identity'),
  ('campaign_plan_items', 'campaign_plan_items_same_workspace'),
  ('campaign_plan_items', 'campaign_plan_items_workspace_immutable'),
  ('campaign_plans', 'campaign_plans_identity'),
  ('campaign_plans', 'campaign_plans_same_workspace'),
  ('campaign_plans', 'campaign_plans_workspace_immutable'),
  ('campaign_goals', 'campaign_goals_same_workspace'),
  ('campaign_pillars', 'campaign_pillars_same_workspace'),
  ('campaigns', 'campaigns_same_workspace'),
  ('campaigns', 'campaigns_workspace_immutable'),
  ('content_item_assets', 'content_item_assets_same_workspace'),
  ('content_items', 'content_items_same_workspace'),
  ('content_items', 'content_items_workspace_immutable'),
  ('content_pillars', 'content_pillars_same_workspace'),
  ('content_pillars', 'content_pillars_workspace_immutable'),
  ('content_reviews', 'content_reviews_immutable'),
  ('content_reviews', 'content_reviews_same_workspace'),
  ('content_reviews', 'content_reviews_workspace_immutable'),
  ('creator_clips', 'creator_clips_project_active'),
  ('creator_clips', 'creator_clips_same_project'),
  ('creator_clips', 'creator_clips_same_workspace'),
  ('creator_clips', 'creator_clips_workspace_immutable'),
  ('creator_exports', 'creator_exports_project_active'),
  ('creator_exports', 'creator_exports_same_project'),
  ('creator_exports', 'creator_exports_same_workspace'),
  ('creator_exports', 'creator_exports_workspace_immutable'),
  ('creator_job_steps', 'creator_job_steps_same_workspace'),
  ('creator_job_steps', 'creator_job_steps_workspace_immutable'),
  ('creator_jobs', 'creator_jobs_project_active'),
  ('creator_jobs', 'creator_jobs_same_project'),
  ('creator_jobs', 'creator_jobs_same_workspace'),
  ('creator_jobs', 'creator_jobs_workspace_immutable'),
  ('creator_project_events', 'creator_project_events_append_only'),
  ('creator_project_events', 'creator_project_events_same_workspace'),
  ('creator_projects', 'creator_projects_workspace_immutable'),
  ('creator_source_parts', 'creator_source_parts_same_workspace'),
  ('creator_source_parts', 'creator_source_parts_workspace_immutable'),
  ('creator_sources', 'creator_sources_project_active'),
  ('creator_sources', 'creator_sources_same_workspace'),
  ('creator_sources', 'creator_sources_workspace_immutable'),
  ('creator_storage_deletions', 'creator_storage_deletions_identity'),
  ('creator_storage_deletions', 'creator_storage_deletions_workspace_immutable'),
  ('creator_transcript_segments', 'creator_transcript_segments_same_workspace'),
  ('creator_transcript_segments', 'creator_transcript_segments_workspace_immutable'),
  ('creator_transcripts', 'creator_transcripts_project_active'),
  ('creator_transcripts', 'creator_transcripts_same_project'),
  ('creator_transcripts', 'creator_transcripts_same_workspace'),
  ('creator_transcripts', 'creator_transcripts_workspace_immutable'),
  ('credit_holds', 'credit_holds_transition'),
  ('credit_holds', 'credit_holds_workspace_immutable'),
  ('credit_ledger_entries', 'credit_ledger_entries_append_only'),
  ('credit_ledger_entries', 'credit_ledger_entries_no_delete'),
  ('credit_ledger_entries', 'credit_ledger_entries_same_workspace'),
  ('credit_recharges', 'credit_recharges_workspace_immutable'),
  ('generated_video_files', 'generated_video_files_delete_guard'),
  ('generated_video_files', 'generated_video_files_immutable'),
  ('generated_video_files', 'generated_video_files_insert_guard'),
  ('generated_video_files', 'generated_video_files_same_workspace'),
  ('generated_video_files', 'generated_video_files_workspace_immutable'),
  ('generated_videos', 'generated_videos_delete_guard'),
  ('generated_videos', 'generated_videos_retention'),
  ('generated_videos', 'generated_videos_workspace_immutable'),
  ('marketing_goals', 'marketing_goals_workspace_immutable'),
  ('marketing_recommendations', 'marketing_recommendations_same_workspace'),
  ('marketing_recommendations', 'marketing_recommendations_workspace_immutable'),
  ('media_assets', 'media_assets_storage_immutable'),
  ('media_assets', 'media_assets_workspace_immutable'),
  ('metric_imports', 'metric_imports_identity'),
  ('metric_imports', 'metric_imports_same_workspace'),
  ('insights_sources', 'insights_sources_same_workspace'),
  ('insights_sources', 'insights_sources_workspace_immutable'),
  ('insights_sources', 'insights_sources_identity'),
  ('insights_sync_runs', 'insights_sync_runs_same_workspace'),
  ('insights_sync_runs', 'insights_sync_runs_workspace_immutable'),
  ('insights_sync_runs', 'insights_sync_runs_record'),
  ('metric_imports', 'metric_imports_workspace_immutable'),
  ('metric_observations', 'metric_observations_immutable'),
  ('metric_observations', 'metric_observations_same_workspace'),
  ('social_agents', 'social_agents_workspace_immutable'),
  ('social_auto_reply_claims', 'social_auto_reply_claims_same_workspace'),
  ('social_auto_reply_claims', 'social_auto_reply_claims_workspace_immutable'),
  ('social_channels', 'social_channels_same_workspace'),
  ('social_channels', 'social_channels_workspace_immutable'),
  ('social_interactions', 'social_interactions_same_workspace'),
  ('social_interactions', 'social_interactions_workspace_immutable'),
  ('social_lessons', 'social_lessons_same_workspace'),
  ('social_lessons', 'social_lessons_workspace_immutable'),
  ('social_posts', 'social_posts_same_workspace'),
  ('social_posts', 'social_posts_workspace_immutable'),
  ('social_replies', 'social_replies_same_workspace'),
  ('social_replies', 'social_replies_workspace_immutable'),
  ('usage_ledger_entries', 'usage_ledger_entries_append_only'),
  ('usage_ledger_entries', 'usage_ledger_entries_same_workspace'),
  ('users', 'users_platform_admin_grant_guard'),
  ('video_generation_attempts', 'video_generation_attempts_same_workspace'),
  ('video_generation_attempts', 'video_generation_attempts_transition'),
  ('video_generation_attempts', 'video_generation_attempts_workspace_immutable'),
  ('video_generation_jobs', 'video_generation_jobs_same_workspace'),
  ('video_generation_jobs', 'video_generation_jobs_transition'),
  ('video_generation_jobs', 'video_generation_jobs_workspace_immutable'),
  ('whatsapp_consent_events', 'whatsapp_consent_events_no_update'),
  ('whatsapp_consent_events', 'whatsapp_consent_events_same_workspace'),
  ('whatsapp_contacts', 'whatsapp_contacts_account'),
  ('whatsapp_contacts', 'whatsapp_contacts_workspace_immutable'),
  ('whatsapp_messages', 'whatsapp_messages_account'),
  ('whatsapp_messages', 'whatsapp_messages_same_workspace'),
  ('whatsapp_messages', 'whatsapp_messages_workspace_immutable'),
  ('whatsapp_snapshots', 'whatsapp_snapshots_account'),
  ('whatsapp_snapshots', 'whatsapp_snapshots_workspace_immutable'),
  ('whatsapp_webhook_events', 'whatsapp_webhook_events_account'),
  ('whatsapp_webhook_events', 'whatsapp_webhook_events_no_update')
) AS expected (table_name, trigger_name)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_trigger t
  WHERE t.tgrelid = to_regclass(format('public.%I', expected.table_name))
    AND t.tgname = expected.trigger_name AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A')
);

-- Constraints that were restored NOT VALID would hide bad rows.
SELECT 'constraints_not_validated', count(*) FROM pg_constraint c
  JOIN pg_namespace n ON n.oid = c.connamespace
  WHERE n.nspname = 'public' AND NOT c.convalidated;

-- Sessions and two-factor rows belong to existing users (cascades intact).
SELECT 'orphan_sessions', count(*) FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE u.id IS NULL;
SELECT 'orphan_two_factors', count(*) FROM two_factors t LEFT JOIN users u ON u.id = t.user_id WHERE u.id IS NULL;
