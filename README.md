# Whiteout Survival Website Backend

Express/TypeScript backend for WhiteoutSurvival.dev features, including the Daybreak Island community showcase.

## Runtime

Required environment variables:

- `MONGODB_URI`
- `MONGODB_DB`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_R2_BUCKET`
- `CLOUDFLARE_R2_PUBLIC_URL`
- `CLOUDFLARE_R2_ACCESS_KEY_ID`
- `CLOUDFLARE_R2_SECRET_ACCESS_KEY`

## Auto Deploy To Oracle

Every push to `main` runs `.github/workflows/deploy-oracle.yml`.

Add these GitHub repository secrets:

- `ORACLE_HOST`: `140.245.201.209`
- `ORACLE_USER`: `ubuntu`
- `ORACLE_TARGET_DIR`: `/home/ubuntu/whiteoutsurvival_dev_backend`
- `ORACLE_SSH_KEY`: private SSH key for the Oracle instance

The workflow builds, uploads, installs production dependencies, restarts PM2, and checks `/api/health`.
