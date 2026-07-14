use serde_json::{Map, Value};

const COMPOSITION_KEYWORDS: [&str; 4] = ["oneOf", "anyOf", "allOf", "not"];

pub fn sanitize_tool_schema_for_compatible_gateway(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => {
            let mut sanitized = Map::new();
            for (key, value) in map {
                if COMPOSITION_KEYWORDS.contains(&key.as_str()) {
                    continue;
                }
                sanitized.insert(
                    key.clone(),
                    sanitize_tool_schema_for_compatible_gateway(value),
                );
            }

            if !enum_matches_declared_type(&sanitized) {
                sanitized.remove("enum");
            }

            Value::Object(sanitized)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(sanitize_tool_schema_for_compatible_gateway)
                .collect(),
        ),
        other => other.clone(),
    }
}

fn enum_matches_declared_type(schema: &Map<String, Value>) -> bool {
    let Some(enum_values) = schema.get("enum") else {
        return true;
    };
    let Some(enum_items) = enum_values.as_array() else {
        return false;
    };
    if enum_items.is_empty() {
        return false;
    }

    let Some(type_name) = schema.get("type").and_then(Value::as_str) else {
        return false;
    };

    enum_items
        .iter()
        .all(|item| enum_value_matches_type(type_name, item))
}

fn enum_value_matches_type(type_name: &str, value: &Value) -> bool {
    match type_name {
        "string" | "STRING" => value.is_string(),
        "number" | "NUMBER" => value.is_number(),
        "integer" | "INTEGER" => value.as_i64().is_some() || value.as_u64().is_some(),
        "boolean" | "BOOLEAN" => value.is_boolean(),
        "array" | "ARRAY" => value.is_array(),
        "object" | "OBJECT" => value.is_object(),
        "null" | "NULL" => value.is_null(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_composition_keywords_recursively() {
        let schema = serde_json::json!({
            "type": "object",
            "oneOf": [{ "required": ["query"] }],
            "properties": {
                "query": {
                    "type": "string",
                    "anyOf": [{ "minLength": 1 }]
                },
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "allOf": [{ "required": ["id"] }],
                        "properties": {
                            "id": { "type": "string", "not": { "enum": [""] } }
                        }
                    }
                }
            }
        });

        let sanitized = sanitize_tool_schema_for_compatible_gateway(&schema);

        assert!(sanitized.get("oneOf").is_none());
        assert!(sanitized["properties"]["query"].get("anyOf").is_none());
        assert!(sanitized["properties"]["items"]["items"]
            .get("allOf")
            .is_none());
        assert!(
            sanitized["properties"]["items"]["items"]["properties"]["id"]
                .get("not")
                .is_none()
        );
    }

    #[test]
    fn keeps_only_enum_values_that_match_declared_type() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "good": { "type": "string", "enum": ["search", "read"] },
                "bad": { "type": "string", "enum": [1, 2] },
                "mixed": { "type": "number", "enum": [1, "2"] },
                "empty": { "type": "string", "enum": [] },
                "missingType": { "enum": ["value"] }
            }
        });

        let sanitized = sanitize_tool_schema_for_compatible_gateway(&schema);

        assert_eq!(
            sanitized["properties"]["good"]["enum"],
            serde_json::json!(["search", "read"])
        );
        assert!(sanitized["properties"]["bad"].get("enum").is_none());
        assert!(sanitized["properties"]["mixed"].get("enum").is_none());
        assert!(sanitized["properties"]["empty"].get("enum").is_none());
        assert!(sanitized["properties"]["missingType"].get("enum").is_none());
    }
}
