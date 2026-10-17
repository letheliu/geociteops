import type { SupportedSchemaType, SchemaTypeDefinition } from './types.js'

export const SUPPORTED_TYPES = [
  'SoftwareApplication',
  'WebApplication',
  'Organization',
  'LocalBusiness',
  'Product',
  'ProductGroup',
  'Offer',
  'Service',
  'FAQPage',
  'QAPage',
  'Article',
  'BlogPosting',
  'NewsArticle',
  'BreadcrumbList',
  'WebSite',
  'WebPage',
  'Person',
  'ProfilePage',
  'ContactPage',
  'VideoObject',
  'ImageObject',
  'Event',
  'JobPosting',
  'Course',
  'Review',
  'AggregateRating',
  'DiscussionForumPosting',
] as const satisfies readonly SupportedSchemaType[]

const SCHEMA_TYPES: Record<SupportedSchemaType, SchemaTypeDefinition> = {
  SoftwareApplication: {
    type: 'SoftwareApplication',
    requiredFields: ['name', 'applicationCategory'],
    optionalFields: ['description', 'url', 'offers', 'aggregateRating', 'operatingSystem'],
  },
  WebApplication: {
    type: 'WebApplication',
    requiredFields: ['name', 'applicationCategory'],
    optionalFields: ['description', 'url', 'offers', 'browserRequirements'],
  },
  Organization: {
    type: 'Organization',
    requiredFields: ['name', 'url'],
    optionalFields: ['logo', 'description', 'sameAs', 'contactPoint', 'foundingDate', 'founder'],
  },
  LocalBusiness: {
    type: 'LocalBusiness',
    requiredFields: ['name', 'address'],
    optionalFields: ['telephone', 'openingHours', 'geo', 'image', 'priceRange'],
  },
  Product: {
    type: 'Product',
    requiredFields: ['name'],
    optionalFields: ['description', 'brand', 'offers', 'image', 'aggregateRating', 'review', 'sku'],
  },
  ProductGroup: {
    type: 'ProductGroup',
    requiredFields: ['name'],
    optionalFields: ['description', 'productGroupID', 'variesBy', 'hasVariant'],
  },
  Offer: {
    type: 'Offer',
    requiredFields: ['price', 'priceCurrency'],
    optionalFields: ['availability', 'url', 'priceValidUntil', 'seller'],
  },
  Service: {
    type: 'Service',
    requiredFields: ['name'],
    optionalFields: ['description', 'provider', 'serviceType', 'areaServed'],
  },
  FAQPage: {
    type: 'FAQPage',
    requiredFields: ['mainEntity'],
    optionalFields: [],
  },
  QAPage: {
    type: 'QAPage',
    requiredFields: ['mainEntity'],
    optionalFields: [],
  },
  Article: {
    type: 'Article',
    requiredFields: ['headline', 'author'],
    optionalFields: ['datePublished', 'dateModified', 'image', 'articleBody', 'publisher'],
  },
  BlogPosting: {
    type: 'BlogPosting',
    requiredFields: ['headline', 'author'],
    optionalFields: ['datePublished', 'dateModified', 'image', 'articleBody', 'publisher'],
  },
  NewsArticle: {
    type: 'NewsArticle',
    requiredFields: ['headline', 'author', 'datePublished'],
    optionalFields: ['dateModified', 'image', 'publisher', 'articleBody'],
  },
  BreadcrumbList: {
    type: 'BreadcrumbList',
    requiredFields: ['itemListElement'],
    optionalFields: [],
  },
  WebSite: {
    type: 'WebSite',
    requiredFields: ['name', 'url'],
    optionalFields: ['potentialAction', 'description'],
  },
  WebPage: {
    type: 'WebPage',
    requiredFields: ['name'],
    optionalFields: ['url', 'description', 'dateModified', 'inLanguage'],
  },
  Person: {
    type: 'Person',
    requiredFields: ['name'],
    optionalFields: ['url', 'jobTitle', 'worksFor', 'sameAs', 'image'],
  },
  ProfilePage: {
    type: 'ProfilePage',
    requiredFields: ['mainEntity'],
    optionalFields: ['url', 'description'],
  },
  ContactPage: {
    type: 'ContactPage',
    requiredFields: ['name'],
    optionalFields: ['url', 'description'],
  },
  VideoObject: {
    type: 'VideoObject',
    requiredFields: ['name', 'thumbnailUrl', 'uploadDate'],
    optionalFields: ['description', 'contentUrl', 'embedUrl', 'duration'],
  },
  ImageObject: {
    type: 'ImageObject',
    requiredFields: ['contentUrl'],
    optionalFields: ['caption', 'width', 'height', 'creator'],
  },
  Event: {
    type: 'Event',
    requiredFields: ['name', 'startDate', 'location'],
    optionalFields: ['endDate', 'description', 'organizer', 'offers', 'image'],
  },
  JobPosting: {
    type: 'JobPosting',
    requiredFields: ['title', 'description', 'hiringOrganization'],
    optionalFields: ['datePosted', 'validThrough', 'employmentType', 'jobLocation', 'baseSalary'],
  },
  Course: {
    type: 'Course',
    requiredFields: ['name', 'description'],
    optionalFields: ['provider', 'url', 'hasCourseInstance'],
  },
  Review: {
    type: 'Review',
    requiredFields: ['author', 'reviewBody'],
    optionalFields: ['reviewRating', 'itemReviewed', 'datePublished'],
  },
  AggregateRating: {
    type: 'AggregateRating',
    requiredFields: ['ratingValue', 'reviewCount'],
    optionalFields: ['bestRating', 'worstRating', 'ratingCount'],
  },
  DiscussionForumPosting: {
    type: 'DiscussionForumPosting',
    requiredFields: ['headline', 'author'],
    optionalFields: ['datePublished', 'text', 'url'],
  },
}

export interface SchemaRegistryService {
  get(type: string): SchemaTypeDefinition | null
  isSupported(type: string): boolean
  list(): SupportedSchemaType[]
}

export function createSchemaRegistry(): SchemaRegistryService {
  return {
    get(type) {
      return (SCHEMA_TYPES as Record<string, SchemaTypeDefinition | undefined>)[type] ?? null
    },
    isSupported(type) {
      return type in SCHEMA_TYPES
    },
    list() {
      return [...SUPPORTED_TYPES]
    },
  }
}
