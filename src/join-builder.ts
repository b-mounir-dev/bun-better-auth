import type { JoinConfig } from "@better-auth/core/db/adapter";
import { quoteColumn, quoteIdentifier, quoteTablePath } from "./query-builders";
import type { BunSqlProvider } from "./types";

type JoinSelectDescriptor = {
  joinModel: string;
  joinModelRef: string;
  field: string;
  alias: string;
};

type BuildJoinPartsArgs = {
  provider: BunSqlProvider;
  baseAlias: string;
  join: JoinConfig | undefined;
  getModelName: (model: string) => string;
  getFieldName: (input: { model: string; field: string }) => string;
  getModelFields: (model: string) => string[];
};

type BuildJoinPartsResult = {
  joinSql: string;
  selectSql: string[];
  selectDescriptors: JoinSelectDescriptor[];
};

export function buildJoinParts({
  provider,
  baseAlias,
  join,
  getModelName,
  getFieldName,
  getModelFields,
}: BuildJoinPartsArgs): BuildJoinPartsResult {
  if (!join) {
    return { joinSql: "", selectSql: [], selectDescriptors: [] };
  }

  const joins: string[] = [];
  const selectSql: string[] = [];
  const descriptors: JoinSelectDescriptor[] = [];

  for (const [joinModel, joinAttr] of Object.entries(join)) {
    const modelRef = joinModel.includes(".") ? joinModel.split(".")[1]! : joinModel;
    const joinAlias = `j_${modelRef.replace(/[^A-Za-z0-9_]/g, "_")}`;
    const fromCol = quoteColumn(provider, baseAlias, joinAttr.on.from);
    const toCol = quoteColumn(provider, joinAlias, joinAttr.on.to);
    joins.push(
      `LEFT JOIN ${quoteTablePath(provider, joinModel)} ${quoteIdentifier(provider, joinAlias)} ON ${toCol} = ${fromCol}`,
    );

    const fields = getModelFields(joinModel);
    for (const schemaField of fields) {
      const dbField = getFieldName({ model: joinModel, field: schemaField });
      const alias = `_joined_${modelRef}_${dbField}`;
      descriptors.push({
        joinModel,
        joinModelRef: modelRef,
        field: dbField,
        alias,
      });
      selectSql.push(
        `${quoteColumn(provider, joinAlias, dbField)} AS ${quoteIdentifier(provider, alias)}`,
      );
    }

    // Ensure joined model name is resolved consistently for output transformation.
    getModelName(joinModel);
  }

  return {
    joinSql: joins.length > 0 ? ` ${joins.join(" ")}` : "",
    selectSql,
    selectDescriptors: descriptors,
  };
}

type ProcessJoinedRowsArgs = {
  rows: Record<string, unknown>[];
  join: JoinConfig | undefined;
  getModelName: (model: string) => string;
  getFieldName: (input: { model: string; field: string }) => string;
  selectDescriptors: JoinSelectDescriptor[];
  mainIdField: string;
};

export function processJoinedRows({
  rows,
  join,
  getModelName,
  getFieldName,
  selectDescriptors,
  mainIdField,
}: ProcessJoinedRowsArgs): Record<string, unknown>[] {
  if (!join || rows.length === 0) {
    return rows;
  }

  const grouped = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    const mainRow: Record<string, unknown> = { ...row };
    const joinedBuckets = new Map<string, Record<string, unknown>>();

    for (const descriptor of selectDescriptors) {
      const value = row[descriptor.alias];
      delete mainRow[descriptor.alias];
      const joinedModelName = getModelName(descriptor.joinModel);
      if (!joinedBuckets.has(joinedModelName)) {
        joinedBuckets.set(joinedModelName, {});
      }
      joinedBuckets.get(joinedModelName)![descriptor.field] = value;
    }

    const mainId = mainRow[mainIdField];
    if (mainId === undefined || mainId === null) {
      continue;
    }
    const key = String(mainId);

    if (!grouped.has(key)) {
      const seed: Record<string, unknown> = { ...mainRow };
      for (const [joinModel, joinAttr] of Object.entries(join)) {
        const joinModelName = getModelName(joinModel);
        seed[joinModelName] = joinAttr.relation === "one-to-one" ? null : [];
      }
      grouped.set(key, seed);
    }

    const entry = grouped.get(key)!;
    for (const [joinModel, joinAttr] of Object.entries(join)) {
      const joinModelName = getModelName(joinModel);
      const joinedData = joinedBuckets.get(joinModelName) ?? {};
      const hasData = Object.values(joinedData).some(
        (value) => value !== null && value !== undefined,
      );
      if (!hasData) {
        continue;
      }

      if (joinAttr.relation === "one-to-one") {
        entry[joinModelName] = joinedData;
        continue;
      }

      const collection = entry[joinModelName] as Record<string, unknown>[];
      const limit = joinAttr.limit ?? 100;
      if (!Array.isArray(collection) || collection.length >= limit) {
        continue;
      }
      const joinIdField = getFieldName({ model: joinModel, field: "id" });
      const joinedId = joinedData[joinIdField];
      const exists =
        joinedId !== undefined
          ? collection.some((item) => item[joinIdField] === joinedId)
          : false;
      if (!exists) {
        collection.push(joinedData);
      }
    }
  }

  return Array.from(grouped.values());
}
