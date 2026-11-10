import React, { useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";

const PAGE_SIZE = 6;

export interface SelectOption<T> {
  label: string;
  value: T;
  detail?: string;
}

export function filterSelectOptions<T>(
  options: readonly SelectOption<T>[],
  query: string,
): SelectOption<T>[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...options];
  return options.filter((option) =>
    `${option.label} ${option.detail ?? ""}`
      .toLocaleLowerCase()
      .includes(normalized),
  );
}

export async function selectOption<T>(
  title: string,
  options: readonly SelectOption<T>[],
): Promise<T | undefined> {
  if (options.length === 0) return undefined;
  let resolveSelection: (value: T | undefined) => void = () => undefined;
  const selected = new Promise<T | undefined>((resolve) => {
    resolveSelection = resolve;
  });
  const instance = render(
    React.createElement(Selector<T>, {
      title,
      options,
      onSelect: resolveSelection,
    }),
    { exitOnCtrlC: false },
  );
  const result = await selected;
  await instance.waitUntilExit();
  return result;
}

function Selector<T>({
  title,
  options,
  onSelect,
}: {
  title: string;
  options: readonly SelectOption<T>[];
  onSelect: (value: T | undefined) => void;
}): React.JSX.Element {
  const { exit } = useApp();
  const [index, setIndex] = useState(0);
  const [query, setQuery] = useState("");
  const filteredOptions = filterSelectOptions(options, query);
  useInput((input, key) => {
    if (key.backspace || key.delete) {
      setQuery((current) => current.slice(0, -1));
      setIndex(0);
      return;
    }
    if (key.upArrow)
      setIndex((current) =>
        filteredOptions.length
          ? (current - 1 + filteredOptions.length) % filteredOptions.length
          : 0,
      );
    else if (key.downArrow)
      setIndex((current) =>
        filteredOptions.length ? (current + 1) % filteredOptions.length : 0,
      );
    else if (key.return) {
      onSelect(filteredOptions[index]?.value);
      exit();
    } else if (key.escape || (key.ctrl && input === "c")) {
      onSelect(undefined);
      exit();
    } else if (input && !key.ctrl && !key.meta && input.length === 1) {
      setQuery((current) => `${current}${input}`);
      setIndex(0);
    }
  });

  const start = Math.max(
    0,
    Math.min(
      index - Math.floor(PAGE_SIZE / 2),
      filteredOptions.length - PAGE_SIZE,
    ),
  );
  const visibleOptions = filteredOptions.slice(start, start + PAGE_SIZE);

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text bold color="cyan">
        {title}
      </Text>
      <Text dimColor>
        Filter: {query || "type a name or ID"} · {filteredOptions.length}{" "}
        {filteredOptions.length === 1 ? "option" : "options"}
      </Text>
      {visibleOptions.map((option, visibleIndex) => {
        const optionIndex = start + visibleIndex;
        return (
          <Text
            key={`${option.label}-${optionIndex}`}
            {...(optionIndex === index ? { color: "green" as const } : {})}
          >
            {optionIndex === index ? "> " : "  "}
            {option.label}
            {option.detail ? <Text dimColor> {option.detail}</Text> : null}
          </Text>
        );
      })}
      {filteredOptions.length === 0 ? (
        <Text dimColor>No options match that filter.</Text>
      ) : null}
      {filteredOptions.length > PAGE_SIZE ? (
        <Text dimColor>
          Showing {start + 1}–
          {Math.min(start + PAGE_SIZE, filteredOptions.length)} of{" "}
          {filteredOptions.length}
        </Text>
      ) : null}
      <Text dimColor>
        ↑/↓ move · type to filter · Backspace edit · Enter select · Esc cancel
      </Text>
    </Box>
  );
}
