// 选卡：纯函数。给它几张卡、几个已经占着卡的任务、一串排队的活，它说谁能上哪张卡、为什么。
// 判断顺序永远是"先看卡可不可用，再看余量，再看已经压了几个任务"——不猜、不为了好看硬塞。

export type Card = {
  index: number;
  label: string;
  usable: boolean;
  total_mb: number | null;
  used_mb: number | null;
  util: number | null;
};

export type WaitingJob = { id: string; name: string; need_mb: number; created_at: number };

export type Assignment = {
  id: string;
  gpu: number | null;
  reason: string;
};

export type PlaceOptions = {
  /** 留在卡上的安全余量，默认 1 GB：显存占满会把整台机器拖慢。 */
  headroom_mb?: number;
  /** 一张卡最多放几个我们的任务，默认 1。多卡机器上宁可散开，排空时也好看。 */
  per_card_limit?: number;
};

/**
 * 这条任务还占不占着那张卡？
 * failed / lost 说明 run 包装进程已经没了（或卡根本读不到），再把它算成"占着"只会让队列白等。
 * stalled / suspect / slow 都还在跑，照占。
 */
export function occupiesSlot(verdict: string): boolean {
  return verdict !== "failed" && verdict !== "lost";
}

/** 起了却一直没进 running 的活等多久算死：Windows 上见过 run 包装进程起来就没了，队列永远停在 starting。 */
export const STUCK_STARTING_MS = 120_000;

export function stuckJobs(
  jobs: { id: string; name: string; state: string; started_at: number | null; created_at?: number | null }[],
  at: number,
  limitMs = STUCK_STARTING_MS,
): { id: string; name: string }[] {
  // started_at 为空说明"起来了但没来得及记下时间"，这时候用 created_at 兜底：
  // 否则一个 starting 的活会永远不算卡住，槽位就一直被它占着。
  return jobs
    .filter((job) => {
      if (job.state !== "starting") return false;
      const since = job.started_at ?? job.created_at ?? null;
      return since !== null && at - since >= limitMs;
    })
    .map((job) => ({ id: job.id, name: job.name }));
}

export function freeMb(card: Card): number | null {
  if (card.total_mb === null || card.used_mb === null) return null;
  return Math.max(0, card.total_mb - card.used_mb);
}

/**
 * @param jobs 已按优先级排好的队列
 * @param cards 这一轮看到的卡
 * @param inUse 每张卡上已经被我们任务占的数量
 */
export function place(
  jobs: WaitingJob[],
  cards: Card[],
  inUse: Map<number, number> = new Map(),
  opts: PlaceOptions = {},
): Assignment[] {
  const headroom = opts.headroom_mb ?? 1024;
  const limit = opts.per_card_limit ?? 1;
  const taken = new Map(inUse);
  const out: Assignment[] = [];

  for (const job of jobs) {
    const usable = cards.filter((c) => c.usable);
    if (!usable.length) {
      out.push({ id: job.id, gpu: null, reason: "还没看到可用的卡" });
      continue;
    }

    const fits: Card[] = [];
    for (const card of usable) {
      const used = taken.get(card.index) ?? 0;
      if (used >= limit) continue;
      const free = freeMb(card);
      if (free === null) {
        // 拿不到余量（WDDM 下常见）：只在卡上没我们的任务时才敢放，并在理由里说清楚。
        if (used === 0) fits.push(card);
        continue;
      }
      if (free - headroom >= job.need_mb) fits.push(card);
    }

    if (!fits.length) {
      const occupied = usable.every((c) => (taken.get(c.index) ?? 0) >= limit);
      out.push({
        id: job.id,
        gpu: null,
        reason: occupied
          ? `卡上都已有任务，等一个结束`
          : `没有卡余量够 ${fmt(job.need_mb)}，等一个结束`,
      });
      continue;
    }

    // 挑：余量大的优先（放得下更重的活），其次利用率低的，最后按卡号稳定。
    fits.sort((a, b) => {
      const fa = freeMb(a);
      const fb = freeMb(b);
      const va = fa === null ? Number.POSITIVE_INFINITY : fa;
      const vb = fb === null ? Number.POSITIVE_INFINITY : fb;
      if (vb !== va) return vb - va;
      const ua = a.util ?? 0;
      const ub = b.util ?? 0;
      if (ua !== ub) return ua - ub;
      return a.index - b.index;
    });
    const card = fits[0];
    taken.set(card.index, (taken.get(card.index) ?? 0) + 1);
    const free = freeMb(card);
    out.push({
      id: job.id,
      gpu: card.index,
      reason:
        free === null
          ? `卡 ${card.index} 上没有我们的任务（余量看不到，先占上）`
          : `卡 ${card.index} 还有 ${fmt(free)} 空闲`,
    });
  }
  return out;
}

function fmt(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;
  return `${mb} MB`;
}
