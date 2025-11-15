// reputationManager.js

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const DB_FILE = './reputation.db';

class ReputationManager {
  constructor() {
    this.db = null;
    this.initializeDatabase();
  }

  async initializeDatabase() {
    this.db = await open({
      filename: DB_FILE,
      driver: sqlite3.Database
    });

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS player_reputation (
        player_id TEXT NOT NULL,
        gang_id TEXT NOT NULL,
        reputation_score INTEGER NOT NULL,
        PRIMARY KEY (player_id, gang_id)
      )
    `);
    console.log('Reputation database is ready.');
  }

  async getReputation(playerId, gangId) {
    if (!this.db) {
      await new Promise(resolve => setTimeout(resolve, 100));
      return this.getReputation(playerId, gangId);
    }
    const result = await this.db.get(
      'SELECT reputation_score FROM player_reputation WHERE player_id = ? AND gang_id = ?',
      playerId,
      gangId
    );
    return result ? result.reputation_score : 0;
  }

  async updateReputation(playerId, gangId, changeAmount) {
    const currentScore = await this.getReputation(playerId, gangId);
    const newScore = currentScore + changeAmount;

    await this.db.run(
      `INSERT INTO player_reputation (player_id, gang_id, reputation_score)
       VALUES (?, ?, ?)
       ON CONFLICT(player_id, gang_id) DO UPDATE SET reputation_score = excluded.reputation_score;`,
      playerId,
      gangId,
      newScore
    );
    console.log(`Reputation updated for ${playerId} with ${gangId}. New score: ${newScore}`);
    return newScore;
  }

  getReputationDescription(score) {
    if (score < -50) return 'hated';
    if (score < -10) return 'hostile';
    if (score <= 10) return 'neutral';
    if (score <= 50) return 'respected';
    return 'friendly';
  }
}

export const reputationManager = new ReputationManager();