import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isRelationshipType,
  isRuleSourceRelationshipUuid,
  normalizeRelationshipDirection,
} from './rule-source-relationship.validation.ts'

test('all approved relationship types are recognized', () => {
  assert.equal(isRelationshipType('SUPERSEDES'), true)
  assert.equal(isRelationshipType('AMENDS'), true)
  assert.equal(isRelationshipType('REFERENCES'), true)
  assert.equal(isRelationshipType('DEPENDS_ON'), true)
  assert.equal(isRelationshipType('CONFLICTS_WITH'), true)
})

test('unknown relationship type rejected', () => {
  assert.equal(isRelationshipType('MADE_UP'), false)
})

test('non-string relationship type rejected', () => {
  assert.equal(isRelationshipType(42), false)
})

test('UUID shape is accepted', () => {
  assert.equal(isRuleSourceRelationshipUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('invalid UUID rejected', () => {
  assert.equal(isRuleSourceRelationshipUuid('not-a-uuid'), false)
})

test('normalizeRelationshipDirection accepts incoming/outgoing/all', () => {
  assert.equal(normalizeRelationshipDirection('incoming'), 'incoming')
  assert.equal(normalizeRelationshipDirection('outgoing'), 'outgoing')
  assert.equal(normalizeRelationshipDirection('all'), 'all')
})

test('normalizeRelationshipDirection defaults to all for anything else', () => {
  assert.equal(normalizeRelationshipDirection(undefined), 'all')
  assert.equal(normalizeRelationshipDirection('sideways'), 'all')
  assert.equal(normalizeRelationshipDirection(42), 'all')
})
