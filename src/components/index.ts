// AgentCMS Components — Re-exports
// Use: import { BlogList, BlogPost } from "@agentcms/core/components";

// Page-level components
export { default as BlogHeader } from "./BlogHeader.astro";
export { default as BlogList } from "./BlogList.astro";
export { default as BlogPostCard } from "./BlogPostCard.astro";
export { default as BlogPost } from "./BlogPost.astro";
export { default as FeaturedPosts } from "./FeaturedPosts.astro";
export { default as Pagination } from "./Pagination.astro";

// Composite components
export { default as TableOfContents } from "./TableOfContents.astro";
export { default as RelatedPosts } from "./RelatedPosts.astro";
export { default as SearchBar } from "./SearchBar.astro";

// Atomic components
export { default as AuthorBadge } from "./AuthorBadge.astro";
export { default as ReadingTime } from "./ReadingTime.astro";
export { default as TagBadge } from "./TagBadge.astro";
