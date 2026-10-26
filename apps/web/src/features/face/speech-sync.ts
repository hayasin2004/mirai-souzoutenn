/** 音声の再生位置と映像フレームを合わせる計算（純粋関数） */

export type TimedFrame = { timestampUs: number; durationUs: number };

/**
 * 再生位置 clockUs で描くフレームを選ぶ。
 * - drawIndex: 描くフレーム（timestamp が再生位置以下で一番新しいもの）。まだ無ければ -1
 * - drop: drawIndex より前の、もう描かなくてよいフレームの数（捨てる）
 * フレームが遅れて届いているときは、届いている中で一番新しいものを描き続ける（止まって見える）。
 */
export function pickFrame(queue: readonly TimedFrame[], clockUs: number): { drawIndex: number; drop: number } {
  let drawIndex = -1;
  for (let i = 0; i < queue.length; i++) {
    if (queue[i]!.timestampUs <= clockUs) drawIndex = i;
    else break;
  }
  return { drawIndex, drop: Math.max(0, drawIndex) };
}

/**
 * 音声を鳴らし始めてよいか。映像が途中で途切れないよう、少しためてから始める。
 * @param bufferedUntilUs 届いているフレームの最後の終わりの時刻
 * @param ended フレームの列が最後まで届いた
 */
export function shouldStartPlayback(bufferedUntilUs: number, ended: boolean, startBufferUs: number): boolean {
  return ended || bufferedUntilUs >= startBufferUs;
}

export type SyncStats = {
  /** 描いたフレーム数 */
  drawn: number;
  /** 描かずに捨てたフレーム数（届くのが遅れた・描画が追いつかなかった） */
  dropped: number;
  /** 描くべき時刻にフレームが届いていなかった回数（映像が止まって見えた） */
  starved: number;
};
