-- Stale-detection triggers for the Scenarios module.
--
-- A scenario is marked 'stale' as soon as any input it depends on
-- changes. The user must explicitly re-run to clear staleness.
-- Implemented as Postgres triggers so the application layer doesn't
-- have to thread "did this write affect a scenario?" through every
-- endpoint.

-- ── Plan updates ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION mark_scenarios_stale_for_plan() RETURNS TRIGGER AS $$
BEGIN
  UPDATE scenarios SET status = 'stale', updated_at = now()
    WHERE status = 'complete' AND plan_id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_plans_stale
  AFTER UPDATE ON plans
  FOR EACH ROW
  WHEN (NEW.updated_at IS DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION mark_scenarios_stale_for_plan();

-- ── Account-level changes (balance history, rate schedule, type config) ─────
-- account_ids_json is a JSONB array; the `?` operator checks membership.

CREATE OR REPLACE FUNCTION mark_scenarios_stale_for_account() RETURNS TRIGGER AS $$
DECLARE
  affected_id TEXT;
BEGIN
  affected_id := COALESCE(NEW.account_id, OLD.account_id);
  UPDATE scenarios SET status = 'stale', updated_at = now()
    WHERE status = 'complete' AND account_ids_json ? affected_id;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_balance_history_stale
  AFTER INSERT OR UPDATE OR DELETE ON account_balance_history
  FOR EACH ROW EXECUTE FUNCTION mark_scenarios_stale_for_account();

CREATE TRIGGER trg_rate_schedule_stale
  AFTER INSERT OR UPDATE OR DELETE ON account_rate_schedule
  FOR EACH ROW EXECUTE FUNCTION mark_scenarios_stale_for_account();

CREATE TRIGGER trg_account_type_config_stale
  AFTER UPDATE ON account_type_config
  FOR EACH ROW EXECUTE FUNCTION mark_scenarios_stale_for_account();

-- ── Account-level: archive a whole account ───────────────────────────────────
-- When a scenario_account is archived we mark scenarios that reference it
-- as stale too.

CREATE OR REPLACE FUNCTION mark_scenarios_stale_for_account_row() RETURNS TRIGGER AS $$
BEGIN
  UPDATE scenarios SET status = 'stale', updated_at = now()
    WHERE status = 'complete' AND account_ids_json ? NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_scenario_accounts_stale
  AFTER UPDATE ON scenario_accounts
  FOR EACH ROW
  WHEN (NEW.is_active IS DISTINCT FROM OLD.is_active
        OR NEW.current_balance IS DISTINCT FROM OLD.current_balance
        OR NEW.type IS DISTINCT FROM OLD.type)
  EXECUTE FUNCTION mark_scenarios_stale_for_account_row();

-- ── Global tax + profile changes affect every running scenario ──────────────

CREATE OR REPLACE FUNCTION mark_all_scenarios_stale() RETURNS TRIGGER AS $$
BEGIN
  UPDATE scenarios SET status = 'stale', updated_at = now()
    WHERE status = 'complete';
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tax_brackets_stale
  AFTER INSERT OR UPDATE OR DELETE ON tax_bracket_schedules
  FOR EACH ROW EXECUTE FUNCTION mark_all_scenarios_stale();

CREATE TRIGGER trg_tax_deductions_stale
  AFTER INSERT OR UPDATE OR DELETE ON tax_deduction_config
  FOR EACH ROW EXECUTE FUNCTION mark_all_scenarios_stale();

CREATE TRIGGER trg_user_profiles_stale
  AFTER UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION mark_all_scenarios_stale();

CREATE TRIGGER trg_state_timeline_stale
  AFTER INSERT OR UPDATE OR DELETE ON state_residence_timeline
  FOR EACH ROW EXECUTE FUNCTION mark_all_scenarios_stale();
