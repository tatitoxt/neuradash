-- Member administration (invites, role changes, removals) and tenant switching.
GRANT INSERT, UPDATE, DELETE ON memberships TO neuradash_app;
--> statement-breakpoint
GRANT INSERT ON users TO neuradash_app;
--> statement-breakpoint
GRANT UPDATE ON sessions TO neuradash_app;
