import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.ts";
import { renderMarkdown } from "../markdown.ts";

interface AssistantMessageProps {
  content: string;
}

export function AssistantMessage({ content }: AssistantMessageProps): React.ReactElement {
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box width={2} flexShrink={0}>
        <Text color={theme.text.accent}>{theme.symbol.assistant + " "}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <Text>{renderMarkdown(content)}</Text>
      </Box>
    </Box>
  );
}
