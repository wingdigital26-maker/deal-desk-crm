"use client";
import { Button } from "../ui/Button";

export default function PrintButton() {
  return (
    <Button variant="primary" onClick={() => window.print()}>
      Print or save as PDF
    </Button>
  );
}
