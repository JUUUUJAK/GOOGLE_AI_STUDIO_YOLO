/**
 * 로컬 VLM JSON 파일 ↔ VlmReviewPanel 이 기대하는 sourceData 문자열
 * (웹 DB는 sourceData를 문자열로 두지만,보내기 JSON은 객체/배열인 경우가 많음)
 */

export type VlmFileEnvelope =
  | { kind: 'wrapper'; record: Record<string, unknown> }
  | { kind: 'raw'; originalText: string }
  | {
      kind: 'arrayRoot';
      /** 저장 시 직렬화할 배열 (첫 항목이 갱신됨) */
      items: unknown[];
      index: number;
      /** task = { sourceData, reviewerNotes, ... } / payload = 통째로 VLM 페이로드 */
      itemKind: 'taskSourceString' | 'taskSourceObject' | 'payload' | 'sharegptFlat';
    }
  | {
      kind: 'nestedArray';
      root: Record<string, unknown>;
      arrayKey: string;
      items: unknown[];
      index: number;
      itemKind: 'taskSourceString' | 'taskSourceObject' | 'payload' | 'sharegptFlat';
    }
  /** sample.json: { "0": { image, conversations }, "1": { ... } } */
  | {
      kind: 'indexedConversationMap';
      root: Record<string, unknown>;
      activeKey: string;
    };

function looksLikeVlmPayload(o: unknown): o is Record<string, unknown> {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const r = o as Record<string, unknown>;
  return !!(r.rawData || r.rawResultData || r.resolvedImagePath || r.legacyImage);
}

function extractFromTaskRecord(obj: Record<string, unknown>): { sourceDataStr: string; reviewerNotes: string } | null {
  const notes = String(obj.reviewerNotes ?? '');
  if (typeof obj.sourceData === 'string') {
    return { sourceDataStr: obj.sourceData, reviewerNotes: notes };
  }
  if (obj.sourceData && typeof obj.sourceData === 'object') {
    return { sourceDataStr: JSON.stringify(obj.sourceData), reviewerNotes: notes };
  }
  if (looksLikeVlmPayload(obj)) {
    return { sourceDataStr: JSON.stringify(obj), reviewerNotes: notes };
  }
  return null;
}

/** sample.json: [{ index, image, conversations }, …] */
function isSharegptFlatItem(o: Record<string, unknown>): boolean {
  return typeof o.image === 'string' && Array.isArray(o.conversations);
}

function classifyArrayItem(item: unknown): {
  sourceDataStr: string;
  reviewerNotes: string;
  itemKind: 'taskSourceString' | 'taskSourceObject' | 'payload' | 'sharegptFlat';
} | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const o = item as Record<string, unknown>;
  const notes = String(o.reviewerNotes ?? '');
  if (typeof o.sourceData === 'string') {
    return { sourceDataStr: o.sourceData, reviewerNotes: notes, itemKind: 'taskSourceString' };
  }
  if (o.sourceData && typeof o.sourceData === 'object') {
    return { sourceDataStr: JSON.stringify(o.sourceData), reviewerNotes: notes, itemKind: 'taskSourceObject' };
  }
  /** 저장 후 rawResultData/ui가 붙어도 배열 항목은 ShareGPT로 유지해야 A/D·항목 수가 깨지지 않음 */
  if (isSharegptFlatItem(o)) {
    return { sourceDataStr: sharegptLikeItemToCanonicalJson(o), reviewerNotes: '', itemKind: 'sharegptFlat' };
  }
  if (looksLikeVlmPayload(o)) {
    return { sourceDataStr: JSON.stringify(o), reviewerNotes: notes, itemKind: 'payload' };
  }
  return null;
}

const NESTED_ARRAY_KEYS = ['tasks', 'items', 'data', 'records', 'results', 'vlm_tasks'] as const;

/** "0","1",… 키 + 각 항목에 image·conversations (ShareGPT/LLaVA보내기 흔한 형태) */
function isIndexedConversationMap(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj);
  if (keys.length === 0) return false;
  for (const k of keys) {
    if (!/^\d+$/.test(k)) return false;
    const v = obj[k];
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const rec = v as Record<string, unknown>;
    if (typeof rec.image !== 'string') return false;
    if (!Array.isArray(rec.conversations)) return false;
  }
  return true;
}

function sharegptLikeItemToCanonicalJson(item: Record<string, unknown>): string {
  const image = String(item.image ?? '');
  const conversations = Array.isArray(item.conversations) ? item.conversations : [];
  let gptFromConv = '';
  for (const c of conversations) {
    if (!c || typeof c !== 'object') continue;
    const from = String((c as Record<string, unknown>).from ?? '').toLowerCase();
    if (from === 'gpt' || from === 'assistant' || from === 'model') {
      gptFromConv = String((c as Record<string, unknown>).value ?? '');
      break;
    }
  }
  const rrd =
    item.rawResultData && typeof item.rawResultData === 'object' && !Array.isArray(item.rawResultData)
      ? (item.rawResultData as Record<string, unknown>)
      : {};
  const uiItem = item.ui && typeof item.ui === 'object' && !Array.isArray(item.ui) ? (item.ui as Record<string, unknown>) : {};

  const dual = itemHasTopLevelReviewFields(item);
  const topOriginalResponse = String(item.original_response ?? '').trim();

  let originalAnswer: string;
  let editedAnswer: string;
  let reviewResult: string;

  if (dual) {
    /** 읽기 전용 GPT 영역 = original_response, 수정란 초기값 = conversations 의 gpt value */
    originalAnswer = topOriginalResponse || String(rrd.originalAnswer ?? rrd.answer ?? gptFromConv).trim() || gptFromConv;
    editedAnswer = String(rrd.editedAnswer ?? uiItem.editedGptResponse ?? '').trim();
    if (!editedAnswer) editedAnswer = gptFromConv;
    const fromRrd = String(rrd.reviewResult ?? uiItem.reviewResult ?? '').trim();
    reviewResult = fromRrd || mapTopLevelResultToStoredReview(item.result);
  } else {
    originalAnswer = String(rrd.originalAnswer ?? rrd.answer ?? gptFromConv).trim() || gptFromConv;
    editedAnswer = String(rrd.editedAnswer ?? uiItem.editedGptResponse ?? '').trim();
    reviewResult = String(rrd.reviewResult ?? uiItem.reviewResult ?? '').trim();
  }

  const rrdOut: Record<string, unknown> = { originalAnswer };
  if (dual) rrdOut.dualGptLayout = true;
  if (editedAnswer) rrdOut.editedAnswer = editedAnswer;
  if (reviewResult) rrdOut.reviewResult = reviewResult;

  return JSON.stringify({
    resolvedImagePath: image,
    rawData: { image, conversations },
    rawResultData: rrdOut,
  });
}

function getGptValueFromConversations(conv: unknown): string {
  if (!Array.isArray(conv)) return '';
  for (const c of conv) {
    if (!c || typeof c !== 'object') continue;
    const from = String((c as Record<string, unknown>).from ?? '').toLowerCase();
    if (from === 'gpt' || from === 'assistant' || from === 'model') {
      return String((c as Record<string, unknown>).value ?? '');
    }
  }
  return '';
}

/** JSON 루트에 `result` + `original_response` 가 함께 있는보내기 양식 */
function itemHasTopLevelReviewFields(item: Record<string, unknown>): boolean {
  return 'result' in item && 'original_response' in item;
}

/** 상위 result 문자열 → rawResultData.reviewResult 저장값 */
function mapTopLevelResultToStoredReview(topResult: unknown): string {
  const s = String(topResult ?? '').trim();
  if (!s) return 'NORMAL';
  const u = s.toUpperCase();
  if (u.includes('NEEDS') || u.startsWith('NEEDS_FIX')) return 'NEEDS_FIX_VP';
  if (s.includes('수정')) return 'NEEDS_FIX_VP';
  if (u === 'NORMAL' || s === '정상') return 'NORMAL';
  return 'NORMAL';
}

/** 저장 시 항목에 넣을 한글 result (UI 검수 결과 반영) */
function storedReviewToTopLevelResult(stored: string): string {
  const u = String(stored ?? '').toUpperCase();
  if (u === 'NORMAL' || !String(stored ?? '').trim()) return '정상';
  if (u.startsWith('NEEDS_FIX') || u.includes('NEEDS_FIX')) return '수정필요(detail)';
  return String(stored);
}

function isStoredReviewNormal(rr: Record<string, unknown> | undefined): boolean {
  const v = String(rr?.reviewResult ?? '').toUpperCase();
  return v === 'NORMAL' || v === '';
}

/**
 * conversations 의 gpt value 로 쓸 문자열.
 * 정상: 수정필요였다가 정상으로 바꾼 경우 등 → gpt 슬롯을 original_response(originalAnswer)로 맞춤.
 * dualGptLayout + 수정필요: editedAnswer 우선(짧은 수정본).
 * 그 외: canonical 원문 또는 대화 슬롯.
 */
function pickSharegptGptValueForExport(
  merged: Record<string, unknown>,
  originalItem: Record<string, unknown>
): string {
  const rr = merged.rawResultData as Record<string, unknown> | undefined;
  const originalFromItem = getGptValueFromConversations(originalItem.conversations);

  if (isStoredReviewNormal(rr)) {
    const fromCanon = String(rr?.originalAnswer ?? rr?.answer ?? rr?.response ?? '').trim();
    const fromTop = String(originalItem.original_response ?? '').trim();
    return (fromCanon || fromTop || originalFromItem).trim();
  }

  if (rr?.dualGptLayout === true) {
    const ed = String(rr?.editedAnswer ?? '').trim();
    return ed || originalFromItem;
  }
  const canonicalOrig = String(rr?.originalAnswer ?? rr?.answer ?? rr?.response ?? '').trim();
  return (canonicalOrig || originalFromItem).trim();
}

function mergedCanonicalToSharegptItem(merged: Record<string, unknown>, originalItem: Record<string, unknown>): Record<string, unknown> {
  const rawData = merged.rawData as Record<string, unknown> | undefined;
  const image = String(merged.resolvedImagePath ?? rawData?.image ?? originalItem.image ?? '');
  let conversations: unknown[] = [];
  if (rawData && Array.isArray(rawData.conversations)) {
    conversations = [...rawData.conversations];
  } else if (Array.isArray(originalItem.conversations)) {
    conversations = [...originalItem.conversations];
  }
  const newGpt = pickSharegptGptValueForExport(merged, originalItem);
  const gptIdx = conversations.findIndex((c: unknown) => {
    if (!c || typeof c !== 'object') return false;
    const from = String((c as Record<string, unknown>).from ?? '').toLowerCase();
    return from === 'gpt' || from === 'assistant' || from === 'model';
  });
  if (gptIdx >= 0) {
    const prev = conversations[gptIdx] as Record<string, unknown>;
    conversations[gptIdx] = { ...prev, value: newGpt, from: prev.from ?? 'gpt' };
  }

  const rr = merged.rawResultData as Record<string, unknown> | undefined;

  /** 디스크에는 result / original_response 만 (rawResultData·dueDate 없음) */
  const out: Record<string, unknown> = { ...originalItem };
  delete out.ui;
  delete out.rawResultData;
  delete out.dueDate;

  out.index = originalItem.index;
  out.image = image;
  out.conversations = conversations;
  out.original_response =
    String(rr?.originalAnswer ?? '').trim() ||
    String(originalItem.original_response ?? '').trim() ||
    newGpt;
  out.result = storedReviewToTopLevelResult(String(rr?.reviewResult ?? ''));

  return out;
}

/** indexedConversationMap 키 정렬 (0,1,2 / 01 등) */
export function sortedNumericKeys(root: Record<string, unknown>): string[] {
  return Object.keys(root)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
}

/** A/D 이동 지원: sharegpt 배열·숫자키 맵 */
export function vlmNavigableListCount(envelope: VlmFileEnvelope | null): number {
  if (!envelope) return 0;
  if (envelope.kind === 'arrayRoot' && envelope.itemKind === 'sharegptFlat') return envelope.items.length;
  if (envelope.kind === 'nestedArray' && envelope.itemKind === 'sharegptFlat') return envelope.items.length;
  if (envelope.kind === 'indexedConversationMap') return sortedNumericKeys(envelope.root).length;
  return 0;
}

export function vlmCurrentSlot(envelope: VlmFileEnvelope | null): number {
  if (!envelope) return 0;
  if (envelope.kind === 'arrayRoot') {
    const n = envelope.items.length;
    return n ? Math.max(0, Math.min(envelope.index, n - 1)) : 0;
  }
  if (envelope.kind === 'nestedArray') {
    const n = envelope.items.length;
    return n ? Math.max(0, Math.min(envelope.index, n - 1)) : 0;
  }
  if (envelope.kind === 'indexedConversationMap') {
    const keys = sortedNumericKeys(envelope.root);
    const i = keys.indexOf(envelope.activeKey);
    return i >= 0 ? i : 0;
  }
  return 0;
}

export function vlmEnvelopeAtSlot(envelope: VlmFileEnvelope, slot: number): VlmFileEnvelope {
  if (envelope.kind === 'arrayRoot' && envelope.itemKind === 'sharegptFlat') {
    const n = envelope.items.length;
    const i = n ? Math.max(0, Math.min(slot, n - 1)) : 0;
    return { ...envelope, index: i };
  }
  if (envelope.kind === 'nestedArray' && envelope.itemKind === 'sharegptFlat') {
    const n = envelope.items.length;
    const i = n ? Math.max(0, Math.min(slot, n - 1)) : 0;
    return { ...envelope, index: i };
  }
  if (envelope.kind === 'indexedConversationMap') {
    const keys = sortedNumericKeys(envelope.root);
    if (keys.length === 0) return envelope;
    const i = Math.max(0, Math.min(slot, keys.length - 1));
    return { ...envelope, activeKey: keys[i] };
  }
  return envelope;
}

/** 항목 객체의 `index` 필드가 있으면 그 값, 없으면 배열 순번(1-based) 또는 숫자 맵 키 */
export function vlmItemListIndex(envelope: VlmFileEnvelope, slot: number): string {
  if (envelope.kind === 'arrayRoot' && envelope.itemKind === 'sharegptFlat') {
    const n = envelope.items.length;
    if (n === 0) return '';
    const i = Math.max(0, Math.min(slot, n - 1));
    const item = envelope.items[i];
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const idx = (item as Record<string, unknown>).index;
      if (idx !== undefined && idx !== null && String(idx).trim() !== '') return String(idx);
    }
    return String(i + 1);
  }
  if (envelope.kind === 'nestedArray' && envelope.itemKind === 'sharegptFlat') {
    const n = envelope.items.length;
    if (n === 0) return '';
    const i = Math.max(0, Math.min(slot, n - 1));
    const item = envelope.items[i];
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const idx = (item as Record<string, unknown>).index;
      if (idx !== undefined && idx !== null && String(idx).trim() !== '') return String(idx);
    }
    return String(i + 1);
  }
  if (envelope.kind === 'indexedConversationMap') {
    const keys = sortedNumericKeys(envelope.root);
    if (keys.length === 0) return '';
    const i = Math.max(0, Math.min(slot, keys.length - 1));
    const key = keys[i];
    const item = envelope.root[key];
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const idx = (item as Record<string, unknown>).index;
      if (idx !== undefined && idx !== null && String(idx).trim() !== '') return String(idx);
    }
    return key;
  }
  return '';
}

export function vlmSourceDataForSlot(envelope: VlmFileEnvelope, slot: number): string | null {
  const env = vlmEnvelopeAtSlot(envelope, slot);
  if (env.kind === 'arrayRoot' && env.itemKind === 'sharegptFlat') {
    const item = env.items[env.index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    return sharegptLikeItemToCanonicalJson(item as Record<string, unknown>);
  }
  if (env.kind === 'nestedArray' && env.itemKind === 'sharegptFlat') {
    const item = env.items[env.index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    return sharegptLikeItemToCanonicalJson(item as Record<string, unknown>);
  }
  if (env.kind === 'indexedConversationMap') {
    const item = env.root[env.activeKey];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    return sharegptLikeItemToCanonicalJson(item as Record<string, unknown>);
  }
  return null;
}

export function parseVlmJsonFile(text: string): {
  sourceDataStr: string;
  reviewerNotes: string;
  envelope: VlmFileEnvelope;
} {
  const trimmed = text.trim();
  try {
    const root = JSON.parse(trimmed) as unknown;

    if (Array.isArray(root) && root.length > 0) {
      const hit = classifyArrayItem(root[0]);
      if (hit) {
        return {
          sourceDataStr: hit.sourceDataStr,
          reviewerNotes: hit.reviewerNotes,
          envelope: {
            kind: 'arrayRoot',
            items: [...root],
            index: 0,
            itemKind: hit.itemKind,
          },
        };
      }
    }

    if (root && typeof root === 'object' && !Array.isArray(root)) {
      const obj = root as Record<string, unknown>;

      if (isIndexedConversationMap(obj)) {
        const activeKey = Object.keys(obj).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))[0];
        const item = obj[activeKey] as Record<string, unknown>;
        return {
          sourceDataStr: sharegptLikeItemToCanonicalJson(item),
          reviewerNotes: '',
          envelope: { kind: 'indexedConversationMap', root: { ...obj }, activeKey },
        };
      }

      const direct = extractFromTaskRecord(obj);
      if (direct) {
        const isWrapper = 'sourceData' in obj;
        if (isWrapper) {
          return {
            sourceDataStr: direct.sourceDataStr,
            reviewerNotes: direct.reviewerNotes,
            envelope: { kind: 'wrapper', record: { ...obj } },
          };
        }
        return {
          sourceDataStr: direct.sourceDataStr,
          reviewerNotes: direct.reviewerNotes,
          envelope: { kind: 'raw', originalText: trimmed },
        };
      }

      for (const key of NESTED_ARRAY_KEYS) {
        const arr = obj[key];
        if (!Array.isArray(arr) || arr.length === 0) continue;
        const hit = classifyArrayItem(arr[0]);
        if (hit) {
          return {
            sourceDataStr: hit.sourceDataStr,
            reviewerNotes: hit.reviewerNotes,
            envelope: {
              kind: 'nestedArray',
              root: { ...obj },
              arrayKey: key,
              items: [...arr],
              index: 0,
              itemKind: hit.itemKind,
            },
          };
        }
      }
    }

    return {
      sourceDataStr: typeof root === 'string' ? root : JSON.stringify(root),
      reviewerNotes: '',
      envelope: { kind: 'raw', originalText: trimmed },
    };
  } catch {
    return {
      sourceDataStr: trimmed,
      reviewerNotes: '',
      envelope: { kind: 'raw', originalText: trimmed },
    };
  }
}

export function buildVlmJsonFileContent(
  envelope: VlmFileEnvelope | null,
  mergedSourceDataStr: string,
  reviewerNotes: string
): string {
  if (envelope?.kind === 'wrapper') {
    return JSON.stringify({ ...envelope.record, sourceData: mergedSourceDataStr, reviewerNotes }, null, 2);
  }

  if (envelope?.kind === 'indexedConversationMap') {
    let merged: Record<string, unknown>;
    try {
      merged = JSON.parse(mergedSourceDataStr) as Record<string, unknown>;
    } catch {
      return mergedSourceDataStr;
    }
    const originalItem = envelope.root[envelope.activeKey] as Record<string, unknown>;
    const newItem = mergedCanonicalToSharegptItem(merged, originalItem);
    const outRoot = { ...envelope.root, [envelope.activeKey]: newItem };
    return JSON.stringify(outRoot, null, 2);
  }

  if (envelope?.kind === 'arrayRoot') {
    const next = [...envelope.items];
    const i = envelope.index;
    const cur = next[i];
    if (envelope.itemKind === 'sharegptFlat' && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      let merged: Record<string, unknown>;
      try {
        merged = JSON.parse(mergedSourceDataStr) as Record<string, unknown>;
      } catch {
        return mergedSourceDataStr;
      }
      next[i] = mergedCanonicalToSharegptItem(merged, cur as Record<string, unknown>);
      return JSON.stringify(next, null, 2);
    }
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
      const o = { ...(cur as Record<string, unknown>) };
      if (envelope.itemKind === 'taskSourceString') {
        o.sourceData = mergedSourceDataStr;
        o.reviewerNotes = reviewerNotes;
      } else if (envelope.itemKind === 'taskSourceObject') {
        try {
          o.sourceData = JSON.parse(mergedSourceDataStr);
        } catch {
          o.sourceData = mergedSourceDataStr;
        }
        o.reviewerNotes = reviewerNotes;
      } else {
        try {
          next[i] = JSON.parse(mergedSourceDataStr);
        } catch {
          next[i] = mergedSourceDataStr;
        }
        return JSON.stringify(next, null, 2);
      }
      next[i] = o;
    }
    return JSON.stringify(next, null, 2);
  }

  if (envelope?.kind === 'nestedArray') {
    const nextItems = [...envelope.items];
    const i = envelope.index;
    const cur = nextItems[i];
    if (envelope.itemKind === 'sharegptFlat' && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      let merged: Record<string, unknown>;
      try {
        merged = JSON.parse(mergedSourceDataStr) as Record<string, unknown>;
      } catch {
        return mergedSourceDataStr;
      }
      nextItems[i] = mergedCanonicalToSharegptItem(merged, cur as Record<string, unknown>);
      const rootOut = { ...envelope.root, [envelope.arrayKey]: nextItems };
      return JSON.stringify(rootOut, null, 2);
    }
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
      const o = { ...(cur as Record<string, unknown>) };
      if (envelope.itemKind === 'taskSourceString') {
        o.sourceData = mergedSourceDataStr;
        o.reviewerNotes = reviewerNotes;
      } else if (envelope.itemKind === 'taskSourceObject') {
        try {
          o.sourceData = JSON.parse(mergedSourceDataStr);
        } catch {
          o.sourceData = mergedSourceDataStr;
        }
        o.reviewerNotes = reviewerNotes;
      } else {
        try {
          nextItems[i] = JSON.parse(mergedSourceDataStr);
        } catch {
          nextItems[i] = mergedSourceDataStr;
        }
        const rootOut = { ...envelope.root, [envelope.arrayKey]: nextItems };
        return JSON.stringify(rootOut, null, 2);
      }
      nextItems[i] = o;
    }
    const rootOut = { ...envelope.root, [envelope.arrayKey]: nextItems };
    return JSON.stringify(rootOut, null, 2);
  }

  try {
    const inner = JSON.parse(mergedSourceDataStr);
    return JSON.stringify(inner, null, 2);
  } catch {
    return mergedSourceDataStr;
  }
}
