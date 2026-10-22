/**
 * 映射缓存：按"字体作用域 + 字符"缓存已验证的还原结果。
 *
 * 失效策略：每个作用域记录一个字体指纹（由探针字符渲染结果哈希得到）。
 * 字体文件或映射发生变化时指纹随之改变，旧缓存自动作废。
 */

import type { FontScope } from '../font-analysis/scope.ts';
import { scopeKey } from '../font-analysis/scope.ts';

export interface MappingEntry {
  /** 可见字符；null 表示"该作用域存在混淆，但此字符尚无可信映射" */
  mapped: string | null;
  /** 匹配相似度 0..1 */
  score: number;
  /** 与次优匹配的差距 0..1，用于置信度判断 */
  margin: number;
}

export interface ScopeRecord {
  key: string;
  scope: FontScope;
  signature: string;
  /** 该作用域是否已被判定为混淆字体 */
  obfuscated: boolean;
  chars: Map<string, MappingEntry>;
  updatedAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  scopes: number;
  entries: number;
}

export interface CacheSnapshot {
  version: 1;
  scopes: Array<{
    key: string;
    scope: FontScope;
    signature: string;
    obfuscated: boolean;
    updatedAt: number;
    chars: Array<[string, MappingEntry]>;
  }>;
}

export class MappingCache {
  private scopes = new Map<string, ScopeRecord>();
  private hits = 0;
  private misses = 0;

  /** 取得（或初始化）作用域记录；指纹变化时清空该作用域的字符映射。 */
  ensureScope(scope: FontScope, signature: string): ScopeRecord {
    const key = scopeKey(scope);
    let record = this.scopes.get(key);
    if (!record) {
      record = {
        key,
        scope,
        signature,
        obfuscated: false,
        chars: new Map(),
        updatedAt: Date.now(),
      };
      this.scopes.set(key, record);
      return record;
    }
    if (record.signature !== signature) {
      record.signature = signature;
      record.chars.clear();
      record.obfuscated = false;
      record.updatedAt = Date.now();
    }
    return record;
  }

  getScope(scope: FontScope): ScopeRecord | undefined {
    return this.scopes.get(scopeKey(scope));
  }

  get(scope: FontScope, char: string): MappingEntry | undefined {
    const record = this.scopes.get(scopeKey(scope));
    if (!record) {
      this.misses += 1;
      return undefined;
    }
    const entry = record.chars.get(char);
    if (entry) this.hits += 1;
    else this.misses += 1;
    return entry;
  }

  set(scope: FontScope, char: string, entry: MappingEntry): void {
    const key = scopeKey(scope);
    let record = this.scopes.get(key);
    if (!record) {
      record = {
        key,
        scope,
        signature: '',
        obfuscated: false,
        chars: new Map(),
        updatedAt: Date.now(),
      };
      this.scopes.set(key, record);
    }
    record.chars.set(char, entry);
    record.updatedAt = Date.now();
  }

  markObfuscated(scope: FontScope, obfuscated: boolean): void {
    const record = this.scopes.get(scopeKey(scope));
    if (record) record.obfuscated = obfuscated;
  }

  isObfuscated(scope: FontScope): boolean {
    return this.scopes.get(scopeKey(scope))?.obfuscated ?? false;
  }

  stats(): CacheStats {
    let entries = 0;
    for (const record of this.scopes.values()) entries += record.chars.size;
    return {
      hits: this.hits,
      misses: this.misses,
      scopes: this.scopes.size,
      entries,
    };
  }

  hitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }

  toSnapshot(): CacheSnapshot {
    return {
      version: 1,
      scopes: [...this.scopes.values()].map((record) => ({
        key: record.key,
        scope: record.scope,
        signature: record.signature,
        obfuscated: record.obfuscated,
        updatedAt: record.updatedAt,
        chars: [...record.chars.entries()],
      })),
    };
  }

  fromSnapshot(snapshot: CacheSnapshot): void {
    if (!snapshot || snapshot.version !== 1) return;
    for (const scope of snapshot.scopes) {
      const record = this.scopes.get(scope.key);
      if (!record) {
        this.scopes.set(scope.key, {
          key: scope.key,
          scope: scope.scope,
          signature: scope.signature,
          obfuscated: scope.obfuscated,
          chars: new Map(scope.chars),
          updatedAt: scope.updatedAt,
        });
        continue;
      }
      // 指纹不一致的旧缓存直接丢弃
      if (record.signature && scope.signature && record.signature !== scope.signature) continue;
      for (const [char, entry] of scope.chars) record.chars.set(char, entry);
      record.obfuscated = record.obfuscated || scope.obfuscated;
    }
  }
}
