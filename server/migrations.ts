import type { Pool, PoolClient } from "pg";

interface Migration {
  version: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: "001_control_plane_read_models",
    sql: `
      CREATE TABLE IF NOT EXISTS siteflow_schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS siteflow_read_models (
        kind text NOT NULL,
        key text NOT NULL,
        payload jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (kind, key)
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_read_models_updated_at
        ON siteflow_read_models (updated_at DESC);

      CREATE TABLE IF NOT EXISTS siteflow_release_commands (
        idempotency_key text PRIMARY KEY,
        operation_id text NOT NULL UNIQUE,
        action text NOT NULL CHECK (action IN ('promote', 'rollback')),
        project_id text NOT NULL,
        channel text NOT NULL CHECK (channel IN ('production', 'staging', 'preview')),
        current_deployment_id text,
        target_deployment_id text NOT NULL,
        actor jsonb NOT NULL,
        reason text NOT NULL,
        state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'succeeded', 'failed')),
        message text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_release_commands_project_channel
        ON siteflow_release_commands (project_id, channel, created_at DESC);
    `
  },
  {
    version: "002_prebuilt_deployments",
    sql: `
      CREATE TABLE IF NOT EXISTS siteflow_projects (
        id text PRIMARY KEY,
        slug text NOT NULL UNIQUE,
        name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS siteflow_deployments (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES siteflow_projects(id),
        source_type text NOT NULL CHECK (source_type IN ('prebuilt')),
        source_branch text,
        source_commit_sha text,
        status text NOT NULL CHECK (status IN ('ready', 'failed')),
        artifact_root text NOT NULL,
        checksum text NOT NULL,
        file_count integer NOT NULL,
        total_bytes bigint NOT NULL,
        preview_host text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_deployments_project_created
        ON siteflow_deployments (project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS siteflow_artifact_routes (
        host text PRIMARY KEY,
        deployment_id text NOT NULL REFERENCES siteflow_deployments(id),
        artifact_root text NOT NULL,
        entrypoint text NOT NULL DEFAULT 'index.html',
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `
  },
  {
    version: "003_project_environment_foundation",
    sql: `
      ALTER TABLE siteflow_projects
        ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
        ADD COLUMN IF NOT EXISTS framework text NOT NULL DEFAULT 'static',
        ADD COLUMN IF NOT EXISTS default_branch text NOT NULL DEFAULT 'main',
        ADD COLUMN IF NOT EXISTS production_branch text NOT NULL DEFAULT 'main',
        ADD COLUMN IF NOT EXISTS repository jsonb NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS build_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

      CREATE TABLE IF NOT EXISTS siteflow_project_environments (
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        name text NOT NULL,
        type text NOT NULL CHECK (type IN ('local', 'preview', 'production', 'custom')),
        branch_pattern text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, name)
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_project_environments_type
        ON siteflow_project_environments (project_id, type);

      CREATE TABLE IF NOT EXISTS siteflow_environment_variables (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        key text NOT NULL,
        target_environment text NOT NULL,
        scope text NOT NULL CHECK (scope IN ('build', 'runtime')),
        source text NOT NULL CHECK (source IN ('sealed', 'external')),
        sealed_value text,
        fingerprint text NOT NULL,
        updated_by jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (project_id, key, target_environment, scope)
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_environment_variables_project
        ON siteflow_environment_variables (project_id, target_environment);
    `
  },
  {
    version: "004_git_source_events",
    sql: `
      CREATE TABLE IF NOT EXISTS siteflow_source_events (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES siteflow_projects(id),
        provider text NOT NULL CHECK (provider IN ('github', 'gitlab', 'gitea', 'generic')),
        provider_delivery_id text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('push', 'pull_request', 'manual')),
        status text NOT NULL CHECK (status IN ('accepted', 'rejected', 'ignored')),
        disposition text NOT NULL CHECK (disposition IN ('build_requested', 'duplicate', 'signature_failed', 'policy_rejected')),
        branch text NOT NULL,
        commit_sha text NOT NULL,
        commit_message text NOT NULL,
        commit_author text NOT NULL,
        pull_request_number integer,
        actor jsonb NOT NULL,
        provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        received_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (provider, provider_delivery_id)
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_source_events_project_created
        ON siteflow_source_events (project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS siteflow_build_jobs (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES siteflow_projects(id),
        source_event_id text NOT NULL UNIQUE REFERENCES siteflow_source_events(id),
        status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled', 'timed_out')),
        framework text NOT NULL,
        install_command text NOT NULL,
        build_command text NOT NULL,
        output_directory text NOT NULL,
        queued_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz,
        finished_at timestamptz,
        worker_id text
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_build_jobs_status_queued
        ON siteflow_build_jobs (status, queued_at);
    `
  },
  {
    version: "005_source_build_worker",
    sql: `
      ALTER TABLE siteflow_build_jobs
        ADD COLUMN IF NOT EXISTS failure_reason text;

      ALTER TABLE siteflow_deployments
        DROP CONSTRAINT IF EXISTS siteflow_deployments_source_type_check;

      ALTER TABLE siteflow_deployments
        ADD CONSTRAINT siteflow_deployments_source_type_check
        CHECK (source_type IN ('prebuilt', 'git'));

      ALTER TABLE siteflow_deployments
        ADD COLUMN IF NOT EXISTS source_event_id text REFERENCES siteflow_source_events(id),
        ADD COLUMN IF NOT EXISTS build_job_id text REFERENCES siteflow_build_jobs(id),
        ADD COLUMN IF NOT EXISTS artifact_manifest jsonb NOT NULL DEFAULT '{}'::jsonb;

      CREATE INDEX IF NOT EXISTS idx_siteflow_deployments_build_job
        ON siteflow_deployments (build_job_id);

      CREATE TABLE IF NOT EXISTS siteflow_build_logs (
        id bigserial PRIMARY KEY,
        build_job_id text NOT NULL REFERENCES siteflow_build_jobs(id) ON DELETE CASCADE,
        line text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_build_logs_job_id
        ON siteflow_build_logs (build_job_id, id);
    `
  },
  {
    version: "006_production_route_state",
    sql: `
      CREATE TABLE IF NOT EXISTS siteflow_project_domains (
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        hostname text NOT NULL,
        channel text NOT NULL CHECK (channel IN ('production', 'staging', 'preview')),
        verified boolean NOT NULL DEFAULT true,
        last_checked_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, hostname)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_siteflow_project_domains_hostname
        ON siteflow_project_domains (hostname);

      CREATE TABLE IF NOT EXISTS siteflow_route_revisions (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        channel text NOT NULL CHECK (channel IN ('production', 'staging', 'preview')),
        deployment_id text NOT NULL REFERENCES siteflow_deployments(id),
        previous_deployment_id text REFERENCES siteflow_deployments(id),
        status text NOT NULL CHECK (status IN ('planned', 'validating', 'pending_apply', 'applied', 'failed', 'drifted', 'superseded')),
        generated_config text NOT NULL,
        validation_summary text NOT NULL,
        actor jsonb NOT NULL,
        reason text NOT NULL,
        idempotency_key text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        applied_at timestamptz,
        failed_reason text
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_route_revisions_project_channel
        ON siteflow_route_revisions (project_id, channel, created_at DESC);

      CREATE TABLE IF NOT EXISTS siteflow_release_channels (
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        name text NOT NULL CHECK (name IN ('production', 'staging', 'preview')),
        current_deployment_id text REFERENCES siteflow_deployments(id),
        pending_deployment_id text REFERENCES siteflow_deployments(id),
        route_revision_id text REFERENCES siteflow_route_revisions(id),
        updated_by jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, name)
      );

      ALTER TABLE siteflow_release_commands
        ADD COLUMN IF NOT EXISTS route_revision_id text REFERENCES siteflow_route_revisions(id);
    `
  },
  {
    version: "007_deploy_hooks",
    sql: `
      CREATE TABLE IF NOT EXISTS siteflow_deploy_hooks (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        name text NOT NULL,
        branch text NOT NULL,
        target_environment text NOT NULL,
        token_hash text NOT NULL UNIQUE,
        token_prefix text NOT NULL,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
        created_by jsonb,
        revoked_by jsonb,
        revoke_reason text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        revoked_at timestamptz,
        last_triggered_at timestamptz
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_deploy_hooks_project_status
        ON siteflow_deploy_hooks (project_id, status, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_siteflow_deploy_hooks_token_hash
        ON siteflow_deploy_hooks (token_hash);

      CREATE TABLE IF NOT EXISTS siteflow_deploy_hook_events (
        id text PRIMARY KEY,
        hook_id text NOT NULL REFERENCES siteflow_deploy_hooks(id) ON DELETE CASCADE,
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        action text NOT NULL CHECK (action IN ('created', 'triggered', 'revoked')),
        actor jsonb,
        summary text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_deploy_hook_events_hook_created
        ON siteflow_deploy_hook_events (hook_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_siteflow_deploy_hook_events_project_created
        ON siteflow_deploy_hook_events (project_id, created_at DESC);
    `
  },
  {
    version: "008_rolling_releases",
    sql: `
      CREATE TABLE IF NOT EXISTS siteflow_rolling_releases (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        channel text NOT NULL CHECK (channel IN ('production', 'staging', 'preview')),
        current_deployment_id text NOT NULL REFERENCES siteflow_deployments(id),
        candidate_deployment_id text NOT NULL REFERENCES siteflow_deployments(id),
        percentage integer NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
        status text NOT NULL CHECK (status IN ('active', 'completed', 'aborted')),
        actor jsonb NOT NULL,
        reason text NOT NULL,
        idempotency_key text NOT NULL UNIQUE,
        route_revision_id text REFERENCES siteflow_route_revisions(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        aborted_at timestamptz
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_siteflow_rolling_releases_active
        ON siteflow_rolling_releases (project_id, channel)
        WHERE status = 'active';

      CREATE INDEX IF NOT EXISTS idx_siteflow_rolling_releases_project_channel
        ON siteflow_rolling_releases (project_id, channel, created_at DESC);
    `
  },
  {
    version: "009_cron_jobs",
    sql: `
      CREATE TABLE IF NOT EXISTS siteflow_cron_jobs (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        name text NOT NULL,
        path text NOT NULL,
        schedule text NOT NULL,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        created_by jsonb,
        disabled_by jsonb,
        disable_reason text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        disabled_at timestamptz,
        last_dispatched_at timestamptz,
        UNIQUE (project_id, name)
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_cron_jobs_project_status
        ON siteflow_cron_jobs (project_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS siteflow_cron_dispatches (
        id text PRIMARY KEY,
        cron_job_id text NOT NULL REFERENCES siteflow_cron_jobs(id) ON DELETE CASCADE,
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        target_url text NOT NULL,
        method text NOT NULL DEFAULT 'GET' CHECK (method IN ('GET')),
        user_agent text NOT NULL,
        status text NOT NULL CHECK (status IN ('queued', 'succeeded', 'failed')),
        reason text NOT NULL,
        scheduled_at timestamptz NOT NULL,
        dispatched_at timestamptz NOT NULL DEFAULT now(),
        response_status integer,
        error_message text,
        idempotency_key text NOT NULL UNIQUE
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_cron_dispatches_job_dispatched
        ON siteflow_cron_dispatches (cron_job_id, dispatched_at DESC);
    `
  },
  {
    version: "010_functions_runtime",
    sql: `
      CREATE TABLE IF NOT EXISTS siteflow_function_invocations (
        id text PRIMARY KEY,
        deployment_id text NOT NULL REFERENCES siteflow_deployments(id) ON DELETE CASCADE,
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        path text NOT NULL,
        method text NOT NULL,
        status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
        response_status integer NOT NULL,
        duration_ms integer NOT NULL CHECK (duration_ms >= 0),
        request_id text NOT NULL UNIQUE,
        logs jsonb NOT NULL DEFAULT '[]'::jsonb,
        error_message text,
        invoked_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_function_invocations_deployment_invoked
        ON siteflow_function_invocations (deployment_id, invoked_at DESC);

      CREATE INDEX IF NOT EXISTS idx_siteflow_function_invocations_project_invoked
        ON siteflow_function_invocations (project_id, invoked_at DESC);
    `
  },
  {
    version: "011_analytics_speed_insights",
    sql: `
      CREATE TABLE IF NOT EXISTS siteflow_analytics_events (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        kind text NOT NULL CHECK (kind IN ('pageview', 'custom', 'web_vital')),
        path text NOT NULL,
        referrer text,
        country text,
        browser text,
        device text,
        event_name text,
        vital_name text CHECK (vital_name IS NULL OR vital_name IN ('CLS', 'FCP', 'FID', 'INP', 'LCP', 'TTFB')),
        vital_value double precision CHECK (vital_value IS NULL OR vital_value >= 0),
        occurred_at timestamptz NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_analytics_events_project_received
        ON siteflow_analytics_events (project_id, received_at DESC);

      CREATE INDEX IF NOT EXISTS idx_siteflow_analytics_events_project_kind_received
        ON siteflow_analytics_events (project_id, kind, received_at DESC);

      CREATE INDEX IF NOT EXISTS idx_siteflow_analytics_events_project_path
        ON siteflow_analytics_events (project_id, path);
    `
  },
  {
    version: "012_observability_log_drains",
    sql: `
      CREATE TABLE IF NOT EXISTS siteflow_saved_log_queries (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        name text NOT NULL,
        filters jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_by jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (project_id, name)
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_saved_log_queries_project_updated
        ON siteflow_saved_log_queries (project_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS siteflow_log_drains (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        name text NOT NULL,
        url text NOT NULL,
        sources text[] NOT NULL,
        minimum_severity text NOT NULL DEFAULT 'info' CHECK (minimum_severity IN ('info', 'warning', 'error')),
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        signing_secret text NOT NULL,
        signing_secret_prefix text NOT NULL,
        created_by jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        last_delivered_at timestamptz,
        CHECK (array_length(sources, 1) > 0),
        CHECK (sources <@ ARRAY['build', 'runtime', 'function', 'cron']::text[]),
        UNIQUE (project_id, name)
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_log_drains_project_status
        ON siteflow_log_drains (project_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS siteflow_log_drain_deliveries (
        id text PRIMARY KEY,
        drain_id text NOT NULL REFERENCES siteflow_log_drains(id) ON DELETE CASCADE,
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        status text NOT NULL CHECK (status IN ('delivered', 'failed')),
        response_status integer,
        events_delivered integer NOT NULL CHECK (events_delivered >= 0),
        attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
        payload_sha256 text NOT NULL,
        error_message text,
        delivered_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_log_drain_deliveries_drain_delivered
        ON siteflow_log_drain_deliveries (drain_id, delivered_at DESC);
    `
  },
  {
    version: "013_team_rbac_audit",
    sql: `
      CREATE TABLE IF NOT EXISTS siteflow_team_members (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        actor_id text NOT NULL,
        actor jsonb NOT NULL,
        role text NOT NULL CHECK (role IN ('owner', 'member', 'developer', 'viewer')),
        permissions text[] NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (array_length(permissions, 1) > 0),
        CHECK (permissions <@ ARRAY['read', 'write', 'admin']::text[]),
        UNIQUE (project_id, actor_id)
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_team_members_project
        ON siteflow_team_members (project_id, role, updated_at DESC);

      CREATE TABLE IF NOT EXISTS siteflow_api_tokens (
        id text PRIMARY KEY,
        project_id text REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        name text NOT NULL,
        token_hash text NOT NULL UNIQUE,
        token_prefix text NOT NULL,
        scopes text[] NOT NULL,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
        created_by jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        revoked_at timestamptz,
        last_used_at timestamptz,
        CHECK (array_length(scopes, 1) > 0),
        CHECK (scopes <@ ARRAY['read', 'write', 'admin']::text[])
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_api_tokens_project_status
        ON siteflow_api_tokens (project_id, status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_siteflow_api_tokens_hash
        ON siteflow_api_tokens (token_hash);

      CREATE TABLE IF NOT EXISTS siteflow_audit_events (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        action text NOT NULL,
        actor jsonb NOT NULL,
        target_type text NOT NULL,
        target_id text NOT NULL,
        summary text NOT NULL,
        reason text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_audit_events_project_created
        ON siteflow_audit_events (project_id, created_at DESC);
    `
  },
  {
    version: "014_firewall_edge_config",
    sql: `
      CREATE TABLE IF NOT EXISTS siteflow_firewall_rules (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        name text NOT NULL,
        action text NOT NULL CHECK (action IN ('allow', 'block', 'challenge')),
        priority integer NOT NULL DEFAULT 100,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_by jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        disabled_at timestamptz,
        UNIQUE (project_id, name)
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_firewall_rules_project_status_priority
        ON siteflow_firewall_rules (project_id, status, priority ASC, updated_at DESC);

      CREATE TABLE IF NOT EXISTS siteflow_edge_config (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        key text NOT NULL,
        value jsonb NOT NULL,
        value_type text NOT NULL CHECK (value_type IN ('boolean', 'number', 'string', 'json')),
        created_by jsonb,
        updated_by jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (project_id, key)
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_edge_config_project_key
        ON siteflow_edge_config (project_id, key);
    `
  },
  {
    version: "015_blob_storage",
    sql: `
      CREATE TABLE IF NOT EXISTS siteflow_blobs (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        pathname text NOT NULL,
        access text NOT NULL DEFAULT 'public' CHECK (access IN ('public', 'private')),
        content_type text NOT NULL,
        cache_control_max_age integer,
        size_bytes bigint NOT NULL,
        sha256 text NOT NULL,
        etag text NOT NULL,
        url text NOT NULL,
        content bytea NOT NULL,
        uploaded_by jsonb,
        uploaded_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (project_id, pathname)
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_blobs_project_pathname
        ON siteflow_blobs (project_id, pathname);
    `
  },
  {
    version: "016_cache_isr_controls",
    sql: `
      CREATE TABLE IF NOT EXISTS siteflow_cache_entries (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        cache_key text NOT NULL,
        path text NOT NULL,
        tags text[] NOT NULL DEFAULT '{}',
        status text NOT NULL DEFAULT 'fresh' CHECK (status IN ('fresh', 'stale', 'purged')),
        content_type text NOT NULL,
        size_bytes bigint NOT NULL,
        etag text NOT NULL,
        max_age_seconds integer NOT NULL DEFAULT 60,
        stale_while_revalidate_seconds integer NOT NULL DEFAULT 300,
        last_generated_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL DEFAULT now(),
        stale_at timestamptz NOT NULL DEFAULT now(),
        purged_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (project_id, cache_key)
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_cache_entries_project_path
        ON siteflow_cache_entries (project_id, path);

      CREATE INDEX IF NOT EXISTS idx_siteflow_cache_entries_project_status
        ON siteflow_cache_entries (project_id, status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_siteflow_cache_entries_project_tags
        ON siteflow_cache_entries USING gin (tags);
    `
  },
  {
    version: "017_routing_rules",
    sql: `
      CREATE TABLE IF NOT EXISTS siteflow_routing_rules (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES siteflow_projects(id) ON DELETE CASCADE,
        name text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('redirect', 'rewrite', 'header')),
        source text NOT NULL,
        destination text,
        status_code integer CHECK (status_code IN (301, 302, 307, 308)),
        headers jsonb NOT NULL DEFAULT '[]'::jsonb,
        priority integer NOT NULL DEFAULT 100,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        created_by jsonb,
        updated_by jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        disabled_at timestamptz,
        UNIQUE (project_id, name)
      );

      CREATE INDEX IF NOT EXISTS idx_siteflow_routing_rules_project_kind_status_priority
        ON siteflow_routing_rules (project_id, kind, status, priority ASC, updated_at DESC);
    `
  },
  {
    version: "018_build_skip_status",
    sql: `
      ALTER TABLE siteflow_build_jobs
        DROP CONSTRAINT IF EXISTS siteflow_build_jobs_status_check;

      ALTER TABLE siteflow_build_jobs
        ADD CONSTRAINT siteflow_build_jobs_status_check
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled', 'timed_out', 'skipped'));
    `
  }
];

async function ensureMigrationTable(client: PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS siteflow_schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function runMigrations(pool: Pool) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await ensureMigrationTable(client);

    for (const migration of migrations) {
      const applied = await client.query("SELECT 1 FROM siteflow_schema_migrations WHERE version = $1", [migration.version]);

      if (applied.rowCount === 0) {
        await client.query(migration.sql);
        await client.query("INSERT INTO siteflow_schema_migrations (version) VALUES ($1)", [migration.version]);
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
