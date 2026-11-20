-- Wake API listeners only after durable activity commits. PostgreSQL folds
-- identical server hints within a transaction; readers replay by event ID.
CREATE FUNCTION notify_server_activity_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('nh_server_events_' || md5(current_database() || ':' || TG_TABLE_SCHEMA), NEW.server_id::text);
  RETURN NULL;
END
$$;
CREATE TRIGGER server_activity_insert_notify AFTER INSERT ON server_events FOR EACH ROW
  EXECUTE FUNCTION notify_server_activity_insert();
