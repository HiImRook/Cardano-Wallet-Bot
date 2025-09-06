
# Cardano Wallet Verification Bot

A Discord bot that verifies Cardano wallet ownership and automatically assigns roles based on NFT holdings.

## Features

- Crypto asset ownership verification via self-transactions
- Automatic role assignment based on NFT policy IDs
- Tiered rarity roles based on NFT collection size
- Continuous monitoring of wallet contents
- Backup and restore functionality

## Setup

1. Clone the repository
2. Install dependencies: `npm install`
3. Create `.env` file with your Discord token
4. Create desired Discord roles
5. Configure roles and policy IDs via `/setupverify`
6. Run with `npm start` or deploy with Docker

## Usage

1. Verify wallet via `/verify`
2. Input wallet address
3. Send exact amount of ADA prompted to same wallet address

## Docker Deployment

```bash
docker build -t cardano-wallet-bot .
docker run -d --name cardano-wallet-bot-1 cardano-wallet-bot