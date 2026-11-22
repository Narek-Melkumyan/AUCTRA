import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AppConfig } from '../config/app-config.js';

/**
 * Argon2id password hashing (OWASP 2024 baseline: m=19 MiB, t=2, p=1 — configurable).
 * Hashes are PHC strings, so parameters can be raised later; `needsRehash` upgrades
 * old hashes transparently on the next successful login.
 */
@Injectable()
export class PasswordService {
  private dummyHash?: Promise<string>;

  constructor(private readonly config: AppConfig) {}

  private get options() {
    return {
      type: argon2.argon2id,
      memoryCost: this.config.argon2MemoryKiB,
      timeCost: this.config.argon2TimeCost,
      parallelism: this.config.argon2Parallelism,
    } as const;
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, this.options);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, this.options);
  }

  /** Burns the same CPU as a real verification so unknown emails are not distinguishable by timing. */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash('auctra-timing-equaliser');
    await this.verify(await this.dummyHash, password);
  }
}
