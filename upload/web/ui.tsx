// Layout pieces shared by every screen.
import { useEffect, useRef, type ReactNode } from "react";
import { Button, Link, type ButtonProps, type LinkProps } from "@sdwa/components";
import type { ShellUser } from "../shared/boot.ts";
import { copy } from "./copy.ts";

/**
 * The design system's button-look link is text-sm / py-2: too small for this
 * audience (48 px touch targets, issue #31). Enlarged here until the design
 * system has a size prop (issue #39).
 */
export function BigLink({ className = "", ...props }: LinkProps & { className?: string }) {
  return <Link {...props} className={`min-h-14 w-full justify-center px-6 text-lg font-semibold ${className}`} />;
}

/** The same enlargement for buttons, until the design system's size prop (issue #39). */
export function BigButton({ className = "", ...props }: ButtonProps & { className?: string }) {
  return <Button {...props} className={`min-h-14 w-full justify-center px-6 text-lg font-semibold ${className}`} />;
}

export function Header({ user, signOutUrl }: { user?: ShellUser; signOutUrl?: string }) {
  return (
    <header className="flex flex-col gap-1 border-b border-border pb-4">
      <p className="text-sm text-muted-foreground">{copy.header.site}</p>
      <h1 className="text-2xl font-bold">{copy.header.title}</h1>
      {user && signOutUrl && (
        <p className="text-sm text-muted-foreground">
          {copy.header.signedInAs(user.name)} {copy.header.notYou}{" "}
          <Link variant="inline" href={signOutUrl}>
            {copy.header.signOut}
          </Link>
        </p>
      )}
    </header>
  );
}

export function Page({ children, user, signOutUrl }: { children: ReactNode; user?: ShellUser; signOutUrl?: string }) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-6 px-4 pb-16 pt-6">
      <Header user={user} signOutUrl={signOutUrl} />
      <main className="flex flex-col gap-6">{children}</main>
    </div>
  );
}

const TOTAL_STEPS = copy.steps.titles.length;

/**
 * The four-step frame: where the member is, and the step's own heading.
 * With `focusHeading`, focus moves to the heading when the step appears, so a
 * screen reader announces the new step (issue #31).
 */
export function StepFrame({
  step,
  children,
  focusHeading = false,
}: {
  step: number;
  children: ReactNode;
  focusHeading?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, [focusHeading, step]);
  return (
    <section className="flex flex-col gap-4" aria-labelledby="step-heading">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-muted-foreground">{copy.steps.stepOf(step + 1, TOTAL_STEPS)}</p>
        <div className="flex gap-1" aria-hidden>
          {copy.steps.titles.map((_, n) => (
            <div key={n} className={`h-2 flex-1 rounded-full ${n <= step ? "bg-primary" : "bg-muted"}`} />
          ))}
        </div>
        <h2 id="step-heading" ref={heading} tabIndex={-1} className="pt-2 text-2xl font-bold outline-none">
          {copy.steps.titles[step]}
        </h2>
      </div>
      {children}
    </section>
  );
}

/** The red required marker. Decorative: the field itself carries `required` (issue #56 adds the full form). */
export function Req() {
  return (
    <span aria-hidden className="text-destructive">
      {" "}
      *
    </span>
  );
}
