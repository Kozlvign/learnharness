"use client";

import { useState } from "react";
import Link from "next/link";
import { BookOpenIcon, ChevronRightIcon, GraduationCapIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CourseSeedDetails, CreateCourseResult } from "@/src/core";

/**
 * New courses proposed from a course (fork, docs/rigor.md rule R7).
 *
 * CourseCreatedCard renders the teacher's create_course call in the course
 * it was proposed from: a quiet line with the new course's name, its folder
 * and a link to open it. CourseSeedCard renders the new course's message[0]
 * (the course-seed marker): collapsed by default like the graph-context
 * card; the tutor reads the same content through the marker's text.
 */

export function CourseCreatedCard({ part }: { part: { output?: unknown; state?: unknown; errorText?: unknown } }) {
	const state = typeof part.state === "string" ? part.state : "";
	const output = part.output as CreateCourseResult | undefined;
	if (state === "output-error") {
		return (
			<div data-testid="course-created-card" className="my-2 text-xs text-muted-foreground">
				<span>The course was not created.</span>{" "}
				<span data-lh-i18n="off">{typeof part.errorText === "string" ? part.errorText : ""}</span>
			</div>
		);
	}
	if (!output?.ok) {
		return (
			<div data-testid="course-created-card" className="my-2 text-xs text-muted-foreground">
				Creating the course…
			</div>
		);
	}
	return (
		<div data-testid="course-created-card" className="my-3 flex items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
			<GraduationCapIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
			<span className="font-medium text-foreground/80">New course created</span>
			<span className="min-w-0 flex-1 truncate">
				<span data-lh-i18n="off">{output.title}</span>
				{" · "}
				<span data-lh-i18n="off">{output.folder}</span>
			</span>
			<Link href={`/chat/${output.chatId}`} className="shrink-0 font-medium text-primary hover:underline">
				Open
			</Link>
		</div>
	);
}

export function CourseSeedCard({ data }: { data: CourseSeedDetails }) {
	const [open, setOpen] = useState(false);
	const books = Array.isArray(data?.books) ? data.books : [];
	return (
		<div data-testid="course-seed-card" className="my-1">
			<button
				type="button"
				data-testid="course-seed-toggle"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
				<span className="font-medium">Proposed course</span>
				<span>Proposed in</span>
				<span data-lh-i18n="off" className="min-w-0 flex-1 truncate">{data?.origin?.title ?? ""}</span>
			</button>
			{open && (
				<div data-testid="course-seed-body" className="mt-1 space-y-2 rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs">
					<SeedField label="Goal" text={data.goal} />
					<SeedField label="Why" text={data.reason} />
					<SeedField label="What you already hold" text={data.background} />
					<div className="text-muted-foreground">
						<span className="font-medium text-foreground/80">When</span>
						<span>: </span>
						<span>{data.timing === "now" ? "It can start now" : "Better after the course it came from"}</span>
					</div>
					{books.length > 0 && (
						<div className="space-y-1">
							<div className="font-medium text-foreground/80">Books</div>
							{books.map((book, i) => (
								<div key={i} className="flex gap-2 text-muted-foreground">
									<BookOpenIcon aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
									<div className="min-w-0">
										<span data-lh-i18n="off" className="text-foreground/80">{book.title}</span>
										<span data-lh-i18n="off"> — {book.author}{book.edition ? ` (${book.edition})` : ""}</span>
										<div data-lh-i18n="off">{book.why}</div>
										{book.path
											? <div className="font-mono text-[11px] break-all" data-lh-i18n="off">{book.path}</div>
											: <div className="italic">No file yet</div>}
									</div>
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function SeedField({ label, text }: { label: string; text: string }) {
	if (!text?.trim()) return null;
	return (
		<div className="text-muted-foreground">
			<span className="font-medium text-foreground/80">{label}</span>
			<span>: </span>
			<span data-lh-i18n="off">{text}</span>
		</div>
	);
}
