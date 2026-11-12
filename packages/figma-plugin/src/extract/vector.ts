import { LIMITS, PATH_DATA_PATTERN } from '../limits.js';
import type { ExportVector, ExportVectorPaths } from '../schema.js';
import { ExtractContext, isFiniteNumber, isId, isRecord, isToken } from './context.js';
import { mapPaints, mapVector } from './paint.js';

type Network = NonNullable<ExportVector['vectorNetwork']>;

function mapPaths(
  ctx: ExtractContext,
  value: unknown,
  nodeId: string,
  field: string,
  budget: { chars: number },
): ExportVectorPaths | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ExportVectorPaths = [];
  for (const path of ctx.cap(value as unknown[], LIMITS.maxVectorPaths, 'vector-paths-truncated', field, nodeId)) {
    if (!isRecord(path) || typeof path['data'] !== 'string') continue;
    const data = path['data'];
    if (data.length > budget.chars) {
      ctx.gap('vector-too-large', 'error', `${field}: path data over the size limit was left out.`, {
        nodeId,
        field,
      });
      continue;
    }
    if (!PATH_DATA_PATTERN.test(data)) {
      ctx.gap('vector-path-invalid', 'error', `${field}: path data had unexpected characters.`, {
        nodeId,
        field,
      });
      continue;
    }
    budget.chars -= data.length;
    out.push({ windingRule: isToken(path['windingRule']) ? path['windingRule'] : 'NONE', data });
  }
  return out;
}

function mapNetwork(ctx: ExtractContext, value: unknown, nodeId: string): Network | undefined {
  if (!isRecord(value) || !Array.isArray(value['vertices']) || !Array.isArray(value['segments'])) {
    return undefined;
  }
  const rawVertices = value['vertices'] as unknown[];
  const rawSegments = value['segments'] as unknown[];
  if (
    rawVertices.length > LIMITS.maxVectorVertices ||
    rawSegments.length > LIMITS.maxVectorSegments
  ) {
    // Partial networks are meaningless, since segments index into vertices.
    ctx.gap('vector-network-too-large', 'error', 'Vector network over the size limit was left out; paths are kept.', {
      nodeId,
    });
    return undefined;
  }

  const vertices = rawVertices.filter(isRecord).flatMap((vertex) => {
    if (!isFiniteNumber(vertex['x']) || !isFiniteNumber(vertex['y'])) return [];
    return [
      {
        x: vertex['x'],
        y: vertex['y'],
        ...(isToken(vertex['strokeCap']) && { strokeCap: vertex['strokeCap'] }),
        ...(isToken(vertex['strokeJoin']) && { strokeJoin: vertex['strokeJoin'] }),
        ...(isFiniteNumber(vertex['cornerRadius']) && { cornerRadius: vertex['cornerRadius'] }),
        ...(isToken(vertex['handleMirroring']) && { handleMirroring: vertex['handleMirroring'] }),
      },
    ];
  });

  const segments = rawSegments.filter(isRecord).flatMap((segment) => {
    const { start, end } = segment;
    if (!Number.isInteger(start) || !Number.isInteger(end)) return [];
    if ((start as number) < 0 || (end as number) < 0) return [];
    const tangentStart = mapVector(segment['tangentStart']);
    const tangentEnd = mapVector(segment['tangentEnd']);
    return [
      {
        start: start as number,
        end: end as number,
        ...(tangentStart && { tangentStart }),
        ...(tangentEnd && { tangentEnd }),
      },
    ];
  });

  const network: Network = { vertices, segments };
  if (Array.isArray(value['regions'])) {
    network.regions = ctx
      .cap(value['regions'] as unknown[], LIMITS.maxVectorRegions, 'vector-regions-truncated', 'Vector regions', nodeId)
      .filter(isRecord)
      .flatMap((region) => {
        if (!Array.isArray(region['loops'])) return [];
        const loops = (region['loops'] as unknown[])
          .slice(0, LIMITS.maxVectorRegions)
          .filter((loop): loop is number[] => Array.isArray(loop) && loop.every((i) => Number.isInteger(i) && i >= 0))
          .map((loop) => loop.slice(0, LIMITS.maxVectorLoopIndices));
        const fills = mapPaints(ctx, region['fills'], nodeId);
        const fillStyleId = region['fillStyleId'];
        if (isId(fillStyleId)) ctx.styleIds.add(fillStyleId);
        return [
          {
            windingRule: isToken(region['windingRule']) ? region['windingRule'] : 'NONZERO',
            loops,
            ...(fills && { fills }),
            ...(isId(fillStyleId) && { fillStyleId }),
          },
        ];
      });
  }
  return network;
}

export function mapNodeVector(ctx: ExtractContext, node: Record<string, unknown>, nodeId: string): ExportVector {
  const budget = { chars: LIMITS.maxVectorChars };
  const out: ExportVector = {};
  const fillGeometry = mapPaths(ctx, ctx.read(node, 'fillGeometry', nodeId), nodeId, 'fillGeometry', budget);
  if (fillGeometry) out.fillGeometry = fillGeometry;
  const strokeGeometry = mapPaths(ctx, ctx.read(node, 'strokeGeometry', nodeId), nodeId, 'strokeGeometry', budget);
  if (strokeGeometry) out.strokeGeometry = strokeGeometry;

  if (node['type'] === 'VECTOR') {
    const vectorPaths = mapPaths(ctx, ctx.read(node, 'vectorPaths', nodeId), nodeId, 'vectorPaths', budget);
    if (vectorPaths) out.vectorPaths = vectorPaths;
    const network = mapNetwork(ctx, ctx.read(node, 'vectorNetwork', nodeId), nodeId);
    if (network) out.vectorNetwork = network;
    else ctx.gap('vector-network-unavailable', 'warning', 'No editable vector network; only outlines kept.', { nodeId });
  }
  return out;
}
