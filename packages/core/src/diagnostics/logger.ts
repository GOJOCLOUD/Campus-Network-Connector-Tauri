/**
 * 诊断信息：只记录"发生了什么"，绝不记录用户复制的原文。
 *
 * 隐私约束（见任务书第六节）：
 *  - 不记录剪贴板原文
 *  - 不记录选区文本
 *  - 只记录字符数量、作用域、匹配分数等元数据
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DiagnosticEvent {
  at: number;
  level: LogLevel;
  event: string;
  data?: Record<string, unknown>;
}

export interface DiagnosticSink {
  emit(event: DiagnosticEvent): void;
}

export class RingBufferSink implements DiagnosticSink {
  private buffer: DiagnosticEvent[] = [];

  constructor(private readonly limit = 500) {}

  emit(event: DiagnosticEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.limit) this.buffer.splice(0, this.buffer.length - this.limit);
  }

  entries(): DiagnosticEvent[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
  }
}

export class Logger {
  private sinks: DiagnosticSink[] = [];

  constructor(private level: LogLevel = 'info') {}

  addSink(sink: DiagnosticSink): void {
    this.sinks.push(sink);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private enabled(level: LogLevel): boolean {
    const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return order.indexOf(level) >= order.indexOf(this.level);
  }

  log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    if (!this.enabled(level)) return;
    const record: DiagnosticEvent = { at: Date.now(), level, event, data };
    for (const sink of this.sinks) sink.emit(record);
  }

  debug(event: string, data?: Record<string, unknown>): void {
    this.log('debug', event, data);
  }

  info(event: string, data?: Record<string, unknown>): void {
    this.log('info', event, data);
  }

  warn(event: string, data?: Record<string, unknown>): void {
    this.log('warn', event, data);
  }

  error(event: string, data?: Record<string, unknown>): void {
    this.log('error', event, data);
  }
}
