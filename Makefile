.PHONY: dev db-up db-down db-logs

dev:
	./start-app.sh

db-up:
	docker compose up -d postgres

db-down:
	docker compose stop postgres

db-logs:
	docker compose logs -f postgres
