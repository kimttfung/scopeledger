"use client";

import React from "react";

export default function PrintRecordButton({
  className,
}: {
  className: string;
}) {
  return (
    <button
      className={className}
      type="button"
      onClick={() => window.print()}
    >
      Print project record
    </button>
  );
}
