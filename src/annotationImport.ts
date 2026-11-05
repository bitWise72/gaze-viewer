import Papa from 'papaparse';

export type ImportedReviewStatus = 'gaze_in' | 'gaze_out' | 'unsure';

export interface ImportedReviewAnnotation {
  status: ImportedReviewStatus | null;
  note: string;
}

export interface AnnotationCsvTable {
  fields: string[];
  rows: Record<string, string>[];
}

export interface DotImportTarget {
  index: number;
  timestamp: number;
}

export interface InstanceImportTarget {
  key: string;
  violationId: string;
  instanceNumber: number;
}

export interface AnnotationImportPlan {
  hasDotsFile: boolean;
  hasInstancesFile: boolean;
  dotReviews: Record<string, ImportedReviewAnnotation>;
  instanceReviews: Record<string, ImportedReviewAnnotation>;
  dotMatched: number;
  instanceMatched: number;
  unmatched: number;
}

function normalizedStatus(value: string | undefined): ImportedReviewStatus | null {
  const status = value?.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (status === 'gaze_in' || status === 'gaze_out' || status === 'unsure') return status;
  return null;
}

function annotationFromRow(row: Record<string, string>, statusColumn: string, noteColumn: string): ImportedReviewAnnotation {
  return {
    status: normalizedStatus(row[statusColumn]),
    note: row[noteColumn]?.trim() ?? '',
  };
}

export function parseAnnotationCsv(text: string): AnnotationCsvTable {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim(),
  });
  if (result.errors.length) {
    throw new Error(`Invalid annotation CSV: ${result.errors[0].message}`);
  }
  return {
    fields: result.meta.fields ?? [],
    rows: result.data,
  };
}

export function buildAnnotationImportPlan(
  tables: AnnotationCsvTable[],
  interviewId: string,
  dotTargets: DotImportTarget[],
  instanceTargets: InstanceImportTarget[]
): AnnotationImportPlan {
  const plan: AnnotationImportPlan = {
    hasDotsFile: false,
    hasInstancesFile: false,
    dotReviews: {},
    instanceReviews: {},
    dotMatched: 0,
    instanceMatched: 0,
    unmatched: 0,
  };

  const instanceKeys = new Map(instanceTargets.map((target) => [
    `${target.violationId}:${target.instanceNumber}`,
    target.key,
  ]));

  for (const table of tables) {
    const fields = new Set(table.fields);
    const isInstanceCsv = fields.has('violation_id') && fields.has('instance_number');
    const isDotCsv = !isInstanceCsv && fields.has('timestamp_seconds') && fields.has('yaw') &&
      fields.has('pitch') && fields.has('Human Verdict');
    if (!isInstanceCsv && !isDotCsv) {
      throw new Error('CSV must have the dot or violation-instance annotation columns');
    }

    if (isDotCsv) plan.hasDotsFile = true;
    if (isInstanceCsv) plan.hasInstancesFile = true;

    for (const row of table.rows) {
      if (row.interview_id !== interviewId) {
        plan.unmatched++;
        continue;
      }

      const annotation = isDotCsv
        ? annotationFromRow(row, 'Human Verdict', 'Notes added')
        : annotationFromRow(row, 'annotation', 'note');
      const hasAnnotation = annotation.status != null || annotation.note.length > 0;

      if (isDotCsv) {
        const timestamp = Number(row.timestamp_seconds);
        if (!Number.isFinite(timestamp)) {
          plan.unmatched++;
          continue;
        }
        let nearest: DotImportTarget | null = null;
        let nearestDifference = Number.POSITIVE_INFINITY;
        for (const target of dotTargets) {
          const difference = Math.abs(target.timestamp - timestamp);
          if (difference < nearestDifference) {
            nearest = target;
            nearestDifference = difference;
          }
        }
        if (!nearest || nearestDifference > 0.05) {
          plan.unmatched++;
          continue;
        }
        plan.dotMatched++;
        if (hasAnnotation) plan.dotReviews[String(nearest.index)] = annotation;
      } else {
        const instanceNumber = Number(row.instance_number);
        const violationId = row.violation_id?.trim();
        if (!violationId || !Number.isInteger(instanceNumber) || instanceNumber < 1) {
          plan.unmatched++;
          continue;
        }
        const key = instanceKeys.get(`${violationId}:${instanceNumber}`) ?? `${violationId}:${instanceNumber - 1}`;
        plan.instanceMatched++;
        if (hasAnnotation) plan.instanceReviews[key] = annotation;
      }
    }
  }

  if (!plan.hasDotsFile && !plan.hasInstancesFile) {
    throw new Error('No dot or violation-instance CSV was found');
  }
  return plan;
}