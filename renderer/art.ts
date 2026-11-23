// The chain NFT art (SPEC §15): an SVG gem built from the chain's live state.
//
//   Stone and cut  from keccak256(id u32 BE)
//   Facets         one ring at 10, 100, 1,000 and 10,000 operations (height)
//   Size           grows with SOL held (total_deposits), on a log scale
//   Glints         one at the start, plus one each time fees earned double from 0.0001 SOL, up to ten
//   Ended          the stone goes grey
//
// Unclaimed chains are drawn as an outline; claimed but not launched, as an uncut stone.

import { keccak_256 } from '@noble/hashes/sha3';

export type ArtInput = {
  id: number;
  stage: 'unclaimed' | 'claimed' | 'launched';
  height: bigint;
  lamportsHeld: bigint;
  feesEarned: bigint;
  ended: boolean;
};

export const STONES = [
  { name: 'Ruby', hue: 350, sat: 78 },
  { name: 'Sapphire', hue: 222, sat: 72 },
  { name: 'Emerald', hue: 148, sat: 62 },
  { name: 'Amethyst', hue: 278, sat: 55 },
  { name: 'Topaz', hue: 32, sat: 85 },
  { name: 'Aquamarine', hue: 186, sat: 60 },
  { name: 'Citrine', hue: 50, sat: 88 },
  { name: 'Rose Quartz', hue: 330, sat: 45 },
  { name: 'Peridot', hue: 88, sat: 62 },
  { name: 'Diamond', hue: 210, sat: 12 },
] as const;

export const CUTS = ['Hexagon', 'Heptagon', 'Octagon', 'Nonagon', 'Decagon', 'Twelve-sided'] as const;
const SIDES = [6, 7, 8, 9, 10, 12];

const LAMPORTS = 1_000_000_000;
const GLINT_UNIT = 100_000n; // 0.0001 SOL

export function traits(a: ArtInput) {
  const u32 = new Uint8Array(4);
  new DataView(u32.buffer).setUint32(0, a.id);
  const h = keccak_256(u32);
  const stone = STONES[h[0] % STONES.length];
  const cutIndex = h[1] % CUTS.length;
  const facets = [10n, 100n, 1_000n, 10_000n].filter((t) => a.height >= t).length;
  const sol = Number(a.lamportsHeld) / LAMPORTS;
  let glints = 0;
  if (a.stage === 'launched') {
    glints = 1;
    for (let f = a.feesEarned / GLINT_UNIT; f > 1n && glints < 10; f /= 2n) glints++;
  }
  return { hash: h, stone, cut: CUTS[cutIndex], sides: SIDES[cutIndex], facets, sol, glints };
}

const f1 = (n: number) => n.toFixed(1);

export function svg(a: ArtInput): string {
  const t = traits(a);
  const { hash: h, sides } = t;
  const W = 400, cx = 200, cy = 200;
  // Size: 70 empty, up to 160 at 10,000 SOL.
  const r = a.stage === 'unclaimed' ? 110 : 70 + Math.min(90, 22.5 * Math.log10(1 + t.sol));
  const rot = (h[2] / 256) * (Math.PI * 2) / sides;
  const pts = (rr: number, twist = 0) =>
    Array.from({ length: sides }, (_, i) => {
      const ang = rot + twist + (i / sides) * Math.PI * 2 - Math.PI / 2;
      return [cx + rr * Math.cos(ang), cy + rr * Math.sin(ang)] as const;
    });
  const poly = (p: readonly (readonly [number, number])[]) => p.map(([x, y]) => `${f1(x)},${f1(y)}`).join(' ');

  const grey = a.ended;
  const hue = t.stone.hue, sat = grey ? 0 : t.stone.sat;
  const col = (l: number, s = sat) => `hsl(${hue} ${s}% ${l}%)`;
  const bg = grey ? '#17181b' : `hsl(${hue} ${Math.round(sat * 0.35)}% 9%)`;

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}" width="${W}" height="${W}">`);
  out.push(`<defs><radialGradient id="g" cx="40%" cy="35%" r="75%"><stop offset="0" stop-color="${col(72)}"/><stop offset="0.55" stop-color="${col(46)}"/><stop offset="1" stop-color="${col(22)}"/></radialGradient>`);
  out.push(`<radialGradient id="halo" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${col(50)}" stop-opacity="0.35"/><stop offset="1" stop-color="${col(50)}" stop-opacity="0"/></radialGradient></defs>`);
  out.push(`<rect width="${W}" height="${W}" fill="${bg}"/>`);

  if (a.stage === 'unclaimed') {
    out.push(`<polygon points="${poly(pts(r))}" fill="none" stroke="#3a3d44" stroke-width="2" stroke-dasharray="6 6"/>`);
    out.push(`<text x="${cx}" y="${cy + 10}" text-anchor="middle" font-family="ui-monospace,monospace" font-size="30" fill="#4a4e57">#${a.id}</text>`);
    out.push(`</svg>`);
    return out.join('');
  }

  if (!grey) out.push(`<circle cx="${cx}" cy="${cy}" r="${f1(r * 1.6)}" fill="url(#halo)"/>`);
  const outer = pts(r);

  if (a.stage === 'claimed') {
    // Uncut: a rough stone with a soft outline.
    const rough = outer.map(([x, y], i) => {
      const j = 0.82 + (h[(i + 3) % 32] / 255) * 0.18;
      return [cx + (x - cx) * j, cy + (y - cy) * j] as const;
    });
    out.push(`<polygon points="${poly(rough)}" fill="url(#g)" opacity="0.55" stroke="${col(70)}" stroke-opacity="0.4" stroke-width="2" stroke-linejoin="round"/>`);
  } else {
    out.push(`<polygon points="${poly(outer)}" fill="url(#g)" stroke="${col(80)}" stroke-opacity="0.7" stroke-width="2" stroke-linejoin="round"/>`);
    // The table (top facet) and lines from it to the girdle.
    const table = pts(r * 0.5);
    out.push(`<polygon points="${poly(table)}" fill="${col(64)}" fill-opacity="0.35" stroke="${col(85)}" stroke-opacity="0.55" stroke-width="1.2"/>`);
    for (let i = 0; i < sides; i++) {
      out.push(`<line x1="${f1(table[i][0])}" y1="${f1(table[i][1])}" x2="${f1(outer[i][0])}" y2="${f1(outer[i][1])}" stroke="${col(85)}" stroke-opacity="0.45" stroke-width="1"/>`);
    }
    // One extra ring of facets per milestone, alternating twist.
    for (let k = 0; k < t.facets; k++) {
      const rr = r * (0.5 + 0.12 * (k + 1));
      const ring = pts(rr, (k % 2 ? 0.5 : 0) * (Math.PI * 2) / sides);
      out.push(`<polygon points="${poly(ring)}" fill="none" stroke="${col(88)}" stroke-opacity="${(0.25 + 0.08 * k).toFixed(2)}" stroke-width="1"/>`);
      for (let i = 0; i < sides; i++) {
        const [x, y] = ring[i];
        out.push(`<line x1="${f1(x)}" y1="${f1(y)}" x2="${f1(outer[i][0])}" y2="${f1(outer[i][1])}" stroke="${col(88)}" stroke-opacity="0.18" stroke-width="0.8"/>`);
      }
    }
    // A highlight wedge.
    out.push(`<polygon points="${poly([outer[sides - 1], outer[0], table[0], table[sides - 1]])}" fill="#fff" fill-opacity="${grey ? 0.06 : 0.14}"/>`);
  }

  // Glints: four-point stars placed from the hash.
  for (let g = 0; g < t.glints; g++) {
    const ang = (h[(4 + g * 2) % 32] / 256) * Math.PI * 2;
    const dist = r * (0.25 + (h[(5 + g * 2) % 32] / 256) * 0.7);
    const x = cx + dist * Math.cos(ang), y = cy + dist * Math.sin(ang);
    const s = 5 + (h[(20 + g) % 32] % 6);
    out.push(`<path d="M${f1(x)} ${f1(y - s)} Q${f1(x)} ${f1(y)} ${f1(x + s)} ${f1(y)} Q${f1(x)} ${f1(y)} ${f1(x)} ${f1(y + s)} Q${f1(x)} ${f1(y)} ${f1(x - s)} ${f1(y)} Q${f1(x)} ${f1(y)} ${f1(x)} ${f1(y - s)}Z" fill="#fff" fill-opacity="${grey ? 0.25 : 0.9}"/>`);
  }

  out.push(`<text x="20" y="${W - 20}" font-family="ui-monospace,monospace" font-size="16" fill="${grey ? '#666' : col(80, Math.min(sat, 40))}" fill-opacity="0.8">#${a.id}</text>`);
  out.push(`</svg>`);
  return out.join('');
}

/** The Core asset metadata (§15): `chain/<id>.json`. */
export function metadata(a: ArtInput & { name: string }, origin: string) {
  const t = traits(a);
  const title = a.name ? `Chain #${a.id}: ${a.name}` : `Chain #${a.id}`;
  return {
    name: title,
    symbol: 'CHAIN',
    description: 'A chain inside the Chains program on Solana. Holding this asset means owning the chain: it earns half of the chain\'s fees.',
    image: `${origin}/chain/${a.id}.svg`,
    external_url: `${origin}/#/chain/${a.id}`,
    attributes: [
      { trait_type: 'Stone', value: t.stone.name },
      { trait_type: 'Cut', value: t.cut },
      { trait_type: 'Status', value: a.ended ? 'Ended' : a.stage === 'launched' ? 'Running' : a.stage === 'claimed' ? 'Not launched' : 'Unclaimed' },
      { trait_type: 'Facets', value: t.facets },
      { trait_type: 'Operations', value: Number(a.height) },
      { trait_type: 'SOL held', value: Number(t.sol.toFixed(4)) },
      { trait_type: 'Glints', value: t.glints },
    ],
    properties: { files: [{ uri: `${origin}/chain/${a.id}.svg`, type: 'image/svg+xml' }], category: 'image' },
  };
}
