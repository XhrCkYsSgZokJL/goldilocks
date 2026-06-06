-- server_agents.inbox_id: allow NULL until the agent's XMTP client has
-- registered for the first time. The empty-string placeholder we used
-- in 003 collided on the UNIQUE constraint as soon as the second agent
-- (reports) tried to insert. Postgres unique constraints already allow
-- multiple NULLs, so dropping NOT NULL is enough to fix the collision.
--
-- Order matters: drop NOT NULL first, then nullify the empty strings
-- (otherwise the UPDATE produces NULL rows that trip the still-active
-- NOT NULL check inside the same transaction).

ALTER TABLE server_agents ALTER COLUMN inbox_id DROP NOT NULL;
UPDATE server_agents SET inbox_id = NULL WHERE inbox_id = '';
